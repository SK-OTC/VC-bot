// What happens when a PM's Google sign-in stops working (Google answers invalid_grant: access was revoked, or the sign-in expired).
//
//  1. The connection is marked disconnected and its stored token is wiped.
//  2. The PM gets a private message (a DM) with a fresh sign-in link, and, for a meeting that was being created, a link that adds
//     the meeting to a Google Calendar by hand WITH the guests invited.
//  3. The meeting's channel gets an "Add to Google Calendar" link WITHOUT any email address: anyone can use it for their own
//     calendar. Guests' addresses are never posted in a channel, and a link carrying them would make every person who clicked it
//     invite all the guests again.
//
// Nothing here logs a link, a code or a token.
import { createConnectCode, markDisconnected } from './calendar-connections.js';
import { hyperlink } from './discord-links.js';
import { buildAuthUrl } from './google-oauth.js';
import { bridgeTimeZone } from './time.js';

const TEMPLATE_URL = 'https://calendar.google.com/calendar/render';
const stamp = (sec) => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261125T210000Z

function templateUrl(m, guests) {
  const u = new URL(TEMPLATE_URL);
  const p = u.searchParams;
  p.set('action', 'TEMPLATE');
  p.set('text', String(m.name).slice(0, 200));
  p.set('dates', `${stamp(m.start_at)}/${stamp(m.start_at + (m.duration_min ?? 60) * 60)}`);
  p.set('details', `Discord: https://discord.com/channels/${m.guild_id}/${m.channel_id}`);
  if (m.location) p.set('location', String(m.location).slice(0, 200));
  p.set('ctz', bridgeTimeZone(m.timezone));
  if (m.repeat === 'weekly') p.set('recur', 'RRULE:FREQ=WEEKLY');
  if (guests.length) p.set('add', guests.join(','));
  return u.toString();
}

/**
 * A link that opens Google Calendar's "new event" form already filled in for this meeting. Guests (if any) are added until the
 * link would be longer than maxLength (Discord messages are limited to 2000 characters); `included` says how many fit.
 * Returns { url, included, total }.
 */
export function addToCalendarLink(m, guests = [], { maxLength = 1200 } = {}) {
  const list = [...guests];
  let url = templateUrl(m, list);
  while (url.length > maxLength && list.length) {
    list.pop();
    url = templateUrl(m, list);
  }
  return { url, included: list.length, total: guests.length };
}

export function reconnectMessage(reconnectUrl) {
  return (
    'Your Google sign-in for the meeting bot stopped working (Google says access was revoked or has expired), so I can no longer add meetings to your calendar.\n\n' +
    (reconnectUrl
      ? `Reconnect here: ${hyperlink('Sign in with Google', reconnectUrl)}\nThe link works once and for 10 minutes. If it has expired, run \`/calendar connect\` in your server for a new one. ` +
        'Google shows an "unverified app" warning: that is expected. Click **Advanced**, then **Go to … (unsafe)**, and leave every box ticked.'
      : 'Reconnect by running `/calendar connect` in your server.')
  );
}

/** Private message about a meeting that could not be created: add it by hand, guests included. */
export function guestLinkMessage(m, link) {
  return (
    `**${m.name}** was not added to your Google Calendar. To add it yourself with your guests invited, open this, check the details and press Save: ${hyperlink('Add to Google Calendar', link.url)}` +
    (link.included < link.total ? `\nOnly the first ${link.included} of ${link.total} guests fit in the link; add the rest in Google Calendar.` : '') +
    '\nAfter you reconnect, change the meeting (for example set its location again with `/update-meeting`) and I will add it. If you add it by hand, do not also let me add it, or it will exist twice.'
  );
}

/** Private message about a meeting whose existing event could not be updated. */
export function staleEventMessage(m) {
  return `**${m.name}** was changed, but its Google Calendar event could not be updated and still shows the old details. After you reconnect, change the meeting again (for example set its location again with \`/update-meeting\`) and I will update it.`;
}

/** The notice for the meeting's channel. No email address, no mention. */
export function channelNotice(m, action, link, { organizerTold }) {
  return (
    `Google Calendar sync is not working for **${m.name}**, so it was not ${action === 'create' ? 'added to' : 'updated on'} the organizer's calendar. ` +
    `To put it on your own calendar: ${hyperlink('Add to Google Calendar', link.url)}\n` +
    (organizerTold ? 'The organizer has been sent a link to reconnect.' : 'The organizer needs to reconnect with `/calendar connect`.')
  );
}

/**
 * Marks the PM disconnected (wiping the token) and, the first time only, DMs them a fresh sign-in link followed by `extraMessages`.
 * Returns { transitioned, dmSent, reconnectText }. `transitioned` is false when the connection was already disconnected, in which
 * case nobody is messaged again. `reconnectText` is the message to send some other private way if the DM could not be delivered.
 * `signIn` is { clientId, redirectUri } (public settings only). Never throws for a failed message.
 */
export async function disconnectAndNotify({ db, discord, signIn, userId, teamId, nowSec, extraMessages = [] }) {
  const transitioned = await markDisconnected(db, userId, 'invalid_grant', nowSec);
  if (!transitioned) return { transitioned: false, dmSent: false, reconnectText: null };

  let url = null;
  if (signIn?.clientId && signIn?.redirectUri && teamId) {
    const state = await createConnectCode(db, { discordUserId: userId, teamId, nowSec });
    url = buildAuthUrl({ clientId: signIn.clientId, redirectUri: signIn.redirectUri, state });
  }
  const reconnectText = reconnectMessage(url);
  const first = await discord.sendDirectMessage(userId, { content: reconnectText });
  if (!first.ok) {
    console.warn(`calendar: could not send the reconnect message: ${first.error}`);
    return { transitioned: true, dmSent: false, reconnectText };
  }
  for (const content of extraMessages) {
    const res = await discord.sendDirectMessage(userId, { content });
    if (!res.ok) console.warn(`calendar: could not send a follow-up message: ${res.error}`);
  }
  return { transitioned: true, dmSent: true, reconnectText };
}
