// /calendar (and its buttons) and the guest-team command handlers (/add-team, /remove-team-member, /show-teams), plus the helpers other commands use for Google Calendar
// (event ids, private follow-up details, resolving which guest team a meeting invites).
//
// Rules that hold everywhere in this file:
//  - Every reply is private (ephemeral): email addresses and account names are never posted in a channel.
//  - Every failure says what went wrong and why.
import { ButtonStyle, ComponentType, ResponseType, MessageFlags } from './discord.js';
import { validateScriptUrl } from './bridge.js';
import { createConnectCode, getConnection } from './calendar-connections.js';
import { disconnectGoogle } from './calendar-disconnect.js';
import { hyperlink } from './discord-links.js';
import { buildAuthUrl } from './google-oauth.js';
import {
  addGuests,
  countSyncedMeetings,
  createTeam,
  deleteCalendarAccount,
  deleteTeam,
  flagMeetingsOwnerDisconnected,
  getCalendarAccount,
  getTeam,
  listGuests,
  listTeams,
  markTeamMeetingsDirty,
  nameKey,
  normalizeName,
  removeGuests,
  saveCalendarAccount,
} from './store.js';
import { canManageOwner, fail, hasManagePerms, reply } from './replies.js';

export const FOLLOWUP_TTL_SEC = 14 * 60; // Discord allows 15 minutes; stay safely inside it
const MAX_TEAM_NAME = 50;
export const MAX_GUESTS_PER_TEAM = 100;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/; // the same rule Code.gs applies
const NO_GUESTS = new Set(['none', '(no guests)', 'no guests']);
const private_ = (text) => reply(text, { ephemeral: true, allowedMentions: { parse: [] } });

/**
 * Which Google connection a meeting made by this person, in this server, goes through.
 *  { provider: 'oauth', email }  their own Google sign-in, connected in THIS server (preferred when both exist)
 *  { provider: 'bridge', email } their Apps Script bridge
 *  { provider: null, reason }    neither; reason is 'other_team' when the sign-in exists but was made in another server
 * A sign-in is only ever used for the server it was made in, so one team's meetings never land on a calendar connected for another.
 */
export async function resolveCalendarAccount(ctx, userId, guildId) {
  const { db, google, bridge } = ctx;
  let reason = null;
  if (google) {
    const conn = await getConnection(db, userId);
    if (conn?.status === 'connected') {
      if (conn.team_id === guildId) return { provider: 'oauth', email: conn.google_email };
      reason = 'other_team';
    }
  }
  if (bridge) {
    const account = await getCalendarAccount(db, userId);
    if (account) return { provider: 'bridge', email: account.account_email ?? null };
  }
  return { provider: null, reason };
}

/** Random Google event id: 'v' + 24 characters from 0-9a-v (the only characters Google accepts). */
export function newEventId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuv'; // 32 characters, so a byte % 32 is uniform
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'v' + Array.from(bytes, (b) => alphabet[b % 32]).join('');
}

/** What the sync step needs to send this person a private message later (valid ~15 minutes). */
export function followupFrom(ctx) {
  const { interaction, nowSec } = ctx;
  return interaction.application_id && interaction.token
    ? { appId: interaction.application_id, token: interaction.token, expires: nowSec + FOLLOWUP_TTL_SEC }
    : null;
}

export const isNoGuests = (raw) => NO_GUESTS.has(normalizeName(raw ?? '').toLowerCase());

/**
 * Which team a command invites. Returns { ok: true, key, name } (key null = nobody) or { ok: false, message }.
 *  - raw given: "none" / "(no guests)" = nobody, otherwise a team the caller owns (any team with Manage Server).
 *  - raw not given: the caller's only team; nobody if they own none; an error if they own several.
 */
export async function resolveTeam(ctx, raw) {
  const { db, guildId, userId, interaction } = ctx;
  if (raw !== undefined) {
    if (isNoGuests(raw)) return { ok: true, key: null, name: null };
    const team = await getTeam(db, guildId, raw);
    if (!team) {
      const mine = await listTeams(db, guildId, { ownerId: hasManagePerms(interaction) ? null : userId });
      const names = mine.map((t) => t.name).join(', ');
      return {
        ok: false,
        message: `I can't find a guest team called **${normalizeName(raw)}**. ${
          names ? `Your teams: ${names}.` : 'You have no teams yet; create one with `/add-team`.'
        } Use \`team:none\` to invite nobody.`,
      };
    }
    if (!canManageOwner(interaction, team.owner_id, userId)) {
      return { ok: false, message: `The team **${team.name}** belongs to someone else. You can only invite teams you own.` };
    }
    return { ok: true, key: team.team_key, name: team.name };
  }
  const owned = await listTeams(db, guildId, { ownerId: userId });
  if (owned.length === 0) return { ok: true, key: null, name: null };
  if (owned.length === 1) return { ok: true, key: owned[0].team_key, name: owned[0].name };
  return {
    ok: false,
    message: `You own several guest teams (${owned.map((t) => t.name).join(', ')}). Pick one with \`team\`, or \`team:none\` to invite nobody.`,
  };
}

/** Autocomplete choices for a `team` option: the caller's teams (all teams with Manage Server). */
export async function suggestTeams(ctx, query, { includeNone }) {
  const teams = await listTeams(ctx.db, ctx.guildId, {
    ownerId: hasManagePerms(ctx.interaction) ? null : ctx.userId,
    query,
  });
  const choices = teams.map((t) => ({ name: t.name.slice(0, 100), value: t.name }));
  const q = String(query ?? '').trim().toLowerCase();
  if (includeNone && (!q || 'none'.includes(q) || '(no guests)'.includes(q))) {
    choices.unshift({ name: '(no guests)', value: 'none' });
  }
  return choices.slice(0, 25);
}

// ---------- /calendar ----------
//
// /calendar has no subcommands. Without options it shows, privately, whether this person's calendar is connected, with buttons:
//   Connect (or Reconnect)  -> replaces the message with a fresh one-time Google sign-in link (made on click, so it is never stale)
//   Disconnect Google       -> revokes and deletes the Google sign-in
//   Disconnect Apps Script  -> deletes the older Apps Script bridge connection
// With `url` it connects the older Apps Script bridge instead (a button cannot take typed text).
// A button acts on the account of whoever clicks it; the message is ephemeral, so only the person who ran /calendar sees it.

export const NOT_ENABLED =
  'Google Calendar sync is not enabled on this bot yet: the admin has not set the BRIDGE_SECRET secret (or the Google sign-in settings). Ask your server admin.';

const CONNECT_HELP =
  'See the setup steps in GOOGLE_CALENDAR.md (Part A): the deployment must be "Execute as: Me" with "Who has access: Anyone", and BOT_SECRET in your script properties must match the bot\'s BRIDGE_SECRET.';

export const CALENDAR_BUTTON = { CONNECT: 'calendar:connect', DISCONNECT_GOOGLE: 'calendar:disconnect-google', DISCONNECT_BRIDGE: 'calendar:disconnect-bridge' };
const MAX_LINK_BUTTON_URL = 512; // Discord's limit for a link button's url

const button = (style, label, customId) => ({ type: ComponentType.BUTTON, style, label, custom_id: customId });
const row = (buttons) => (buttons.length ? [{ type: ComponentType.ACTION_ROW, components: buttons }] : []);
/** Answers a button click by replacing the message the button is on (ephemeral stays ephemeral). */
const updateMessage = (content, components = []) => ({ type: ResponseType.UPDATE_MESSAGE, data: { content, components, allowed_mentions: { parse: [] } } });

/**
 * A private, one-time Google sign-in link for this person and this server: { ok: true, content, components } or { ok: false, message }.
 */
async function googleSignIn(ctx) {
  const { db, google, userId, guildId, nowSec } = ctx;
  if (!google) {
    return {
      ok: false,
      message:
        'Google sign-in is not set up on this bot yet (the admin has not set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY). ' +
        'Ask your server admin. If you use the Apps Script bridge instead, add its address: `/calendar url:<your script URL>`.',
    };
  }
  if (!guildId) return { ok: false, message: 'Run `/calendar` inside your server, not in a direct message.' };
  const existing = await getConnection(db, userId);
  if (existing?.status === 'connected') {
    return {
      ok: false,
      message: `Your Google account (${existing.google_email}) is already connected. To connect a different one, run \`/calendar\`, press **Disconnect Google**, then **Connect**.`,
    };
  }
  const state = await createConnectCode(db, { discordUserId: userId, teamId: guildId, nowSec });
  const link = buildAuthUrl({ clientId: google.clientId, redirectUri: google.redirectUri, state });
  const help =
    'This link is for you only and works once, for 10 minutes. Google will show an **"unverified app"** warning: that is expected. ' +
    'Click **Advanced**, then **Go to … (unsafe)**, and leave every permission box ticked. Meetings you schedule in this server will use the account you pick.';
  // A link button is tidier, but Discord refuses one whose url is longer than 512 characters: then the link goes in the text.
  if (link.length <= MAX_LINK_BUTTON_URL) {
    return { ok: true, content: `**Connect your Google Calendar**\n${help}`, components: row([{ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: 'Sign in with Google', url: link }]) };
  }
  return { ok: true, content: `**Connect your Google Calendar**\n${hyperlink('Sign in with Google', link)}\n\n${help}`, components: [] };
}

const unexpectedDisconnect = () => 'Something went wrong on my side and I could not finish disconnecting. Please try again.';

/** The reply after a Google sign-in was disconnected. */
function disconnectedText(out) {
  const who = out.email ? ` **${out.email}**` : '';
  const revoke = {
    revoked: 'I revoked the bot\'s access at Google, so it should disappear from https://myaccount.google.com/permissions (it can take a moment).',
    already_invalid: 'Google had already ended this sign-in, so there was nothing left to revoke.',
    not_needed: 'Google had already stopped accepting this sign-in, so there was nothing left to revoke.',
    manual: 'I could not revoke the access at Google for you. To be sure it is gone, remove the bot at https://myaccount.google.com/permissions.',
  }[out.revoked];
  const meetings = out.affected
    ? `${out.affected === 1 ? '1 upcoming meeting keeps its Google event' : `${out.affected} upcoming meetings keep their Google events`} but will no longer sync; ` +
      '`/upcoming-meetings` marks them. Events already in your calendar are not deleted.'
    : 'None of your upcoming meetings were synced, so nothing else changed.';
  return `Disconnected your Google account${who}. ${revoke}\n${meetings}\nReconnect any time with \`/calendar\`.`;
}

/** Disconnects the Google sign-in. Returns the text to show, or null when the person has none. */
async function disconnectGoogleAccount(ctx) {
  const { db, google, userId, nowSec } = ctx;
  const out = google?.disconnect
    ? await google.disconnect(userId, nowSec)
    : await disconnectGoogle({ db, config: null, discordUserId: userId, nowSec });
  if (!out.ok) return out.error;
  if (out.outcome === 'none') return null;
  const bridgeLeft = await getCalendarAccount(db, userId);
  return (
    disconnectedText(out) +
    (bridgeLeft ? '\nYou also have an Apps Script calendar connected. Run `/calendar` again and press **Disconnect Apps Script** to remove that one too.' : '')
  );
}

/** Disconnects the Apps Script bridge. Returns the text to show. */
async function disconnectBridgeAccount(ctx) {
  const { db, userId } = ctx;
  const account = await getCalendarAccount(db, userId);
  if (!account) return 'Your Apps Script calendar is not connected, so there is nothing to disconnect.';
  await deleteCalendarAccount(db, userId);
  const affected = await flagMeetingsOwnerDisconnected(db, userId, 'bridge');
  return (
    `Disconnected${account.account_email ? ` ${account.account_email}` : ''}. ` +
    (affected
      ? `${affected === 1 ? '1 upcoming meeting keeps its Google event' : `${affected} upcoming meetings keep their Google events`} but will no longer sync; ` +
        '`/upcoming-meetings` marks them. Reconnect with `/calendar`; you can then change a meeting to sync it again.'
      : 'None of your upcoming meetings were synced, so nothing else changed.')
  );
}

function googleStatusText(conn, { synced, failed }, guildId) {
  if (conn.status !== 'connected') {
    return (
      `**Google sign-in: disconnected.** It was **${conn.google_email}**, and Google stopped accepting it` +
      `${conn.last_refresh_at ? ` <t:${conn.last_refresh_at}:R>` : ''}. Press **Reconnect** to sign in again.`
    );
  }
  const check = !conn.last_refresh_at
    ? 'not checked yet'
    : conn.last_refresh_result === 'ok'
      ? `working (checked <t:${conn.last_refresh_at}:R>)`
      : `had a temporary problem <t:${conn.last_refresh_at}:R>`;
  return (
    `**Google sign-in: connected** as **${conn.google_email}** (since <t:${conn.token_issued_at}:D>), ${check}.\n` +
    (conn.team_id === guildId ? 'It is used for meetings in this server.' : 'It was connected in a different server, so it is not used for meetings in this one. Press **Disconnect Google**, then **Connect** here, to use it in this server.') +
    `\nUpcoming synced meetings: ${synced}${failed ? `, ${failed} with a sync problem (see \`/upcoming-meetings\`)` : ''}.`
  );
}

/** /calendar with no options: whether this person is connected, plus the buttons that fit. */
async function calendarStatus(ctx) {
  const { db, google, userId, guildId } = ctx;
  const conn = await getConnection(db, userId);
  const account = await getCalendarAccount(db, userId);
  const parts = [];
  if (!conn && !account) {
    parts.push(
      google
        ? 'Your Google Calendar is **not connected**. Press **Connect** to sign in with Google.'
        : 'Your Google Calendar is **not connected**. Google sign-in is not set up on this bot; if you use the Apps Script bridge, run `/calendar url:<your script URL>`.',
    );
  }
  if (conn) parts.push(googleStatusText(conn, await countSyncedMeetings(db, userId, 'oauth'), guildId));
  if (account) {
    const { synced, failed } = await countSyncedMeetings(db, userId, 'bridge');
    parts.push(
      `**Apps Script calendar: connected** as ${account.account_email ?? 'an unknown account'} (since <t:${account.connected_at}:D>).\n` +
        `Upcoming synced meetings: ${synced}${failed ? `, ${failed} with a sync problem (see \`/upcoming-meetings\`)` : ''}.`,
    );
  }
  const buttons = [];
  if (google && conn?.status !== 'connected') buttons.push(button(ButtonStyle.PRIMARY, conn ? 'Reconnect' : 'Connect', CALENDAR_BUTTON.CONNECT));
  if (conn) buttons.push(button(ButtonStyle.DANGER, 'Disconnect Google', CALENDAR_BUTTON.DISCONNECT_GOOGLE));
  if (account) buttons.push(button(ButtonStyle.DANGER, 'Disconnect Apps Script', CALENDAR_BUTTON.DISCONNECT_BRIDGE));
  return reply(parts.join('\n\n'), { ephemeral: true, components: row(buttons) });
}

export async function cmdCalendar(ctx, o) {
  const { db, discord, bridge, google, userId, nowSec, interaction } = ctx;
  // With neither feature set up there is nothing to connect, but anyone who still has a stored connection must be able to see it and
  // remove it (an admin may have removed the settings after they connected).
  if (!bridge && !google && !(await getConnection(db, userId)) && !(await getCalendarAccount(db, userId))) return fail(NOT_ENABLED);
  if (o.url === undefined) return calendarStatus(ctx);

  if (!bridge) {
    return fail('The Apps Script bridge is not enabled on this bot (BRIDGE_SECRET is not set). Run `/calendar` without a url and press **Connect** to sign in with Google instead.');
  }
  const check = validateScriptUrl(o.url ?? '', { extraHosts: ctx.extraHosts ?? [] });
  if (!check.ok) return fail(`Could not connect: ${check.error}`);

  // Apps Script can be slow, so the real work happens after we answer Discord.
  const run = async () => {
    const res = await bridge.call(check.url, { action: 'ping' });
    if (!res.ok) return `Could not connect: ${res.error}\n${CONNECT_HELP}`;
    const account = res.account ?? null;
    await saveCalendarAccount(db, userId, check.url, account, nowSec);
    return (
      `Connected as ${account ?? 'your Google account (the script did not report an address)'}. ` +
      'Meetings you schedule from now on are added to this Google Calendar. Set up who to invite with `/add-team`.'
    );
  };

  const { application_id: appId, token } = interaction;
  if (!ctx.defer || !appId || !token) return private_(await run().catch((e) => `Could not connect: unexpected error: ${e?.message ?? e}`));
  ctx.defer(
    (async () => {
      let content;
      try {
        content = await run();
      } catch (e) {
        console.error('calendar connect failed:', e?.stack ?? e);
        content = `Could not connect: unexpected error: ${e?.message ?? e}`;
      }
      const res = await discord.editOriginal(appId, token, { content });
      if (!res.ok) console.error(`calendar connect: could not edit the reply: ${res.error}`);
    })(),
  );
  return { type: ResponseType.DEFERRED, data: { flags: MessageFlags.EPHEMERAL } };
}

/** A click on one of the /calendar buttons. Always answers by replacing that (private) message. */
export async function cmdCalendarButton(ctx, customId) {
  if (customId === CALENDAR_BUTTON.CONNECT) {
    const r = await googleSignIn(ctx);
    return r.ok ? updateMessage(r.content, r.components) : updateMessage(r.message);
  }
  if (customId === CALENDAR_BUTTON.DISCONNECT_BRIDGE) return updateMessage(await disconnectBridgeAccount(ctx));
  if (customId !== CALENDAR_BUTTON.DISCONNECT_GOOGLE) return updateMessage('That button is no longer in use. Run `/calendar` again.');

  // Revoking at Google can take longer than Discord's 3 seconds: say "working on it", then edit the message when it is done.
  const run = async () => (await getConnection(ctx.db, ctx.userId) ? (await disconnectGoogleAccount(ctx)) ?? unexpectedDisconnect() : 'Your Google sign-in is not connected, so there is nothing to disconnect.');
  const { discord, defer, interaction } = ctx;
  const { application_id: appId, token } = interaction;
  if (!defer || !appId || !token) return updateMessage(await run().catch(() => unexpectedDisconnect()));
  defer(
    (async () => {
      let content;
      try {
        content = await run();
      } catch (e) {
        console.error(`calendar disconnect failed: ${String(e?.name ?? 'Error').slice(0, 40)}`);
        content = unexpectedDisconnect();
      }
      const res = await discord.editOriginal(appId, token, { content, components: [] });
      if (!res.ok) console.error(`calendar disconnect: could not edit the reply: ${res.error}`);
    })(),
  );
  return { type: ResponseType.DEFERRED_UPDATE };
}

// ---------- guest teams ----------

function parseEmails(raw) {
  const valid = [];
  const invalid = [];
  for (const part of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const email = part.toLowerCase();
    if (email.length <= 254 && EMAIL_RE.test(email)) {
      if (!valid.includes(email)) valid.push(email);
    } else {
      invalid.push(part.slice(0, 60));
    }
  }
  return { valid, invalid };
}

const invalidNote = (invalid) => (invalid.length ? `\nNot valid email addresses, skipped: ${invalid.join(', ')}` : '');

function checkTeamName(raw) {
  const name = normalizeName(raw ?? '');
  if (!name) return { ok: false, message: 'Give the team a name.' };
  if (name.length > MAX_TEAM_NAME) return { ok: false, message: `The team name is too long (max ${MAX_TEAM_NAME} characters).` };
  if (isNoGuests(name)) return { ok: false, message: `"${name}" is reserved (it means "invite nobody"). Pick another team name.` };
  return { ok: true, name };
}

const meetingsText = (n) => `${n} upcoming meeting${n === 1 ? '' : 's'}`;
// Only meetings on the changer's own Google Calendar are updated there (see markTeamMeetingsDirty); say what happened to the rest.
const updatedNote = ({ updated, notUpdated }) =>
  (updated ? `\n${meetingsText(updated)} will be updated on Google Calendar shortly.` : '') +
  (notUpdated
    ? `\n${meetingsText(notUpdated)} on other people's Google Calendars ${notUpdated === 1 ? 'was' : 'were'} not changed there: ` +
      `a change is sent to Google only by the calendar's owner, so ${notUpdated === 1 ? 'it gets' : 'they get'} the new guest list ` +
      `the next time the owner changes ${notUpdated === 1 ? 'it' : 'them'}.`
    : '');
const NO_MEETINGS = { updated: 0, notUpdated: 0 };

export async function cmdGuests(ctx, sub, o) {
  const { db, guildId, userId, nowSec, interaction } = ctx;

  if (sub === 'list' && o.team === undefined) {
    const teams = await listTeams(db, guildId, { ownerId: hasManagePerms(interaction) ? null : userId });
    if (!teams.length) return private_('You do not own any guest teams yet. Create one with `/add-team team:Design emails:someone@example.com`.');
    const lines = teams.map((t) => `- **${t.name}**: ${t.guest_count} ${t.guest_count === 1 ? 'guest' : 'guests'}${t.owner_id === userId ? '' : ` (owner <@${t.owner_id}>)`}`);
    return private_(`**Guest teams**\n${lines.join('\n')}`);
  }

  const nameCheck = checkTeamName(o.team);
  if (!nameCheck.ok) return fail(nameCheck.message);
  const teamName = nameCheck.name;
  let team = await getTeam(db, guildId, teamName);

  if (sub === 'add') {
    const { valid, invalid } = parseEmails(o.emails);
    if (!valid.length) {
      return fail(`I couldn't find a valid email address in what you typed.${invalidNote(invalid)}\nExample: \`/add-team team:Design emails:a@example.com, b@example.com\``);
    }
    if (team && !canManageOwner(interaction, team.owner_id, userId)) {
      return fail(`The team **${team.name}** belongs to someone else, so you can't add to it. Pick another team name.`);
    }
    // All or nothing against the limit: work out what is new BEFORE changing anything.
    const have = team ? new Set(await listGuests(db, guildId, team.team_key)) : new Set();
    const already = valid.filter((e) => have.has(e));
    const fresh = valid.filter((e) => !have.has(e));
    const spaces = MAX_GUESTS_PER_TEAM - have.size;
    if (fresh.length > spaces) {
      return fail(
        `A team holds at most ${MAX_GUESTS_PER_TEAM} addresses, and nothing was added. ` +
          `${team ? `**${team.name}** has` : 'A new team has'} ${spaces} ${spaces === 1 ? 'space' : 'spaces'} left, ` +
          `but ${fresh.length} of the addresses you sent are new. Send fewer, or remove some people first with \`/remove-team-member\`.` +
          invalidNote(invalid),
      );
    }

    const created = !team;
    if (created) {
      await createTeam(db, guildId, teamName, userId, nowSec);
      team = await getTeam(db, guildId, teamName);
    }
    await addGuests(db, guildId, team.team_key, fresh);
    // One update for the team's upcoming meetings, however many people were added.
    const affected = fresh.length && !created ? await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec, { actorId: userId }) : NO_MEETINGS;
    const total = have.size + fresh.length;
    const lines = [`${created ? 'Created the team' : 'Updated the team'} **${team.name}**: added ${fresh.length}, ${total} in total.`];
    if (already.length) lines.push(`Already on the team: ${already.join(', ')}`);
    return private_(lines.join('\n') + invalidNote(invalid) + updatedNote(affected));
  }

  if (!team) return fail(`I can't find a guest team called **${teamName}**. Try \`/show-teams\`.`);
  if (!canManageOwner(interaction, team.owner_id, userId)) {
    return fail(`The team **${team.name}** belongs to someone else, so you can't ${sub === 'list' ? 'see its addresses' : sub === 'remove' ? 'remove people from it' : 'delete it'}.`);
  }

  if (sub === 'remove') {
    if (o.emails === undefined) {
      return fail(`Give the \`emails\` to remove from **${team.name}**, or \`all:True\` to delete the whole team.`);
    }
    const { valid, invalid } = parseEmails(o.emails);
    if (!valid.length) return fail(`I couldn't find a valid email address in what you typed.${invalidNote(invalid)}`);
    const have = new Set(await listGuests(db, guildId, team.team_key));
    const removed = valid.filter((e) => have.has(e));
    const missing = valid.filter((e) => !have.has(e));
    await removeGuests(db, guildId, team.team_key, removed);
    const affected = removed.length ? await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec, { actorId: userId }) : NO_MEETINGS;
    const lines = [`Removed ${removed.length} from **${team.name}**, ${have.size - removed.length} left.`];
    if (missing.length) lines.push(`Not on the team, nothing to remove: ${missing.join(', ')}`);
    return private_(lines.join('\n') + invalidNote(invalid) + updatedNote(affected));
  }

  if (sub === 'list') {
    const emails = await listGuests(db, guildId, team.team_key);
    return private_(`**${team.name}** (${emails.length} ${emails.length === 1 ? 'guest' : 'guests'})\n${emails.length ? emails.join('\n') : 'No addresses yet. Add some with `/add-team`.'}`);
  }

  if (sub === 'delete-team') {
    if (o.emails !== undefined) return fail('Pick either `emails` (remove those people) or `all:True` (delete the whole team), not both. Nothing was changed.');
    const { updated, notUpdated } = await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec, { clearTeam: true, actorId: userId });
    await deleteTeam(db, guildId, team.team_key);
    return private_(
      `Deleted the team **${team.name}** and its addresses.` +
        (updated ? `\n${meetingsText(updated)} will be updated on Google Calendar shortly, without guests.` : '') +
        (notUpdated
          ? `\n${meetingsText(notUpdated)} on other people's Google Calendars keep${notUpdated === 1 ? 's' : ''} these guests there until ` +
            `the owner next changes ${notUpdated === 1 ? 'it' : 'them'} (a change is sent to Google only by the calendar's owner).`
          : '') +
        ' Presets that used this team will schedule without guests.',
    );
  }

  return fail("I don't know that team command.");
}
