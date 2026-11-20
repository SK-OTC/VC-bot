// Recognises a link to a Discord channel in a meeting's `location`, e.g. https://discord.com/channels/<server id>/<channel id>
// (the format "Copy Link" gives, and the one this bot already writes into Google Calendar events). Only that exact shape counts: a
// message link (which has a third number), a direct-message link (@me), another website, a <#channel> mention or plain text is
// "not a voice channel link", and the scheduled auto-join does nothing for it. Optional < > around the link are allowed.
const CHANNEL_LINK = /^<?https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/?>?$/;

/** { guildId, channelId } or null. */
export function parseChannelLink(location) {
  const m = CHANNEL_LINK.exec(String(location ?? '').trim());
  return m ? { guildId: m[1], channelId: m[2] } : null;
}
