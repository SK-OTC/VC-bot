// The one Discord message that holds the summary and the link to the full summary on the Worker's web page.
//
// Discord's Create Message "content" is "up to 2000 characters" (https://docs.discord.com/developers/resources/message).
// The page on the Worker always has the FULL summary. Only the copy in this message is shortened, and only when it does not
// fit: the shortened summary ends with an ellipsis, and the link text after it is always complete (the link is wrapped in
// <...>, which stops Discord from adding a preview card). Lengths are counted with JavaScript's string length, which is never
// less than the number of characters Discord counts, so staying under the limit here keeps the message under it there too.
export const DISCORD_CONTENT_LIMIT = 2000;

/** The link lines that end the message. `expiresAt` is a unix time in seconds (shown as a Discord date), or null. */
export function linkBlock(url, expiresAt = null) {
  const until = expiresAt ? ` until <t:${Math.trunc(expiresAt)}:D>` : '';
  return `\n\n🔗 **Full summary and Q&A:** <${url}>\nAnyone with the link can open and edit it${until}.`;
}

/** At most `max` characters of `text`, never cutting a character (surrogate pair) in half. */
function hardCut(text, max) {
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const HEADING = /^\s*\*\*[^*]+\*\*:?\s*$/;

/**
 * summary + link block in one message of at most `limit` characters. A summary that fits is kept whole, with no ellipsis.
 * One that does not fit is cut at a line boundary (never in the middle of a line unless the first line alone is too long),
 * a heading left alone at the end is dropped, and "…" marks the cut.
 */
export function composeSummaryMessage({ summary, url, expiresAt = null, limit = DISCORD_CONTENT_LIMIT }) {
  const suffix = linkBlock(url, expiresAt);
  const text = String(summary ?? '').trim();
  if (!text) return suffix.trimStart();
  if (text.length + suffix.length <= limit) return text + suffix;

  const budget = limit - suffix.length - 2; // room for "\n…"
  if (budget < 1) return suffix.trimStart(); // absurdly small limit: the link matters more than the summary

  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (used + add > budget) break;
    kept.push(line);
    used += add;
  }
  while (kept.length > 1 && (HEADING.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
  let shown = kept.join('\n').replace(/\s+$/, '');
  if (!shown || (kept.length === 1 && HEADING.test(shown))) shown = hardCut(lines[0], budget).replace(/\s+$/, '');
  return `${shown}\n…${suffix}`;
}
