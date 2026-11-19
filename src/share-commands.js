// /share-transcript and /unshare-transcript. Every transcript already gets an automatic link when it is saved; these
// make a fresh one (for example after the first expired) or turn all of them off.
//
// Who may use them: a transcript can only be found from the private channel it was posted in, so only people who can
// use commands in that channel can create or revoke its links. The reply is private to the person who ran the command.
import { fail, reply } from './replies.js';
import { TRANSCRIPT_ID_RE } from './recording-store.js';
import { DEFAULT_DAYS, MAX_DAYS, configuredDays, createShareLink, findTranscriptInChannel, linkUrl, publicOrigin, revokeLinks } from './share-store.js';

const NOT_HERE =
  "I can't find a transcript for this channel. Run this command in the private channel where the bot posted the transcript.";

function pickId(o) {
  if (o.id === undefined || String(o.id).trim() === '') return { ok: true, id: null };
  const id = String(o.id).trim().toLowerCase();
  return TRANSCRIPT_ID_RE.test(id) ? { ok: true, id } : { ok: false };
}

async function resolveTranscript(ctx, o) {
  const picked = pickId(o);
  if (!picked.ok) return { error: fail('That is not a transcript ID. It is the 6 characters after "ID" in the transcript message, for example `k3m9xa`.') };
  const t = await findTranscriptInChannel(ctx.db, ctx.guildId, ctx.interaction.channel_id, picked.id);
  if (!t) return { error: fail(picked.id ? `I can't find a transcript with ID \`${picked.id}\` in this channel.` : NOT_HERE) };
  return { t };
}

export async function cmdShareTranscript(ctx, o) {
  const { db, nowSec, userId, origin, env } = ctx;
  const { t, error } = await resolveTranscript(ctx, o);
  if (error) return error;

  let days = o.days === undefined ? configuredDays(env) || DEFAULT_DAYS : Number(o.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return fail(`\`days\` must be a whole number from 1 to ${MAX_DAYS}.`);

  const link = await createShareLink(db, { transcriptId: t.id, createdBy: userId, days }, nowSec);
  if (!link.ok) return fail(`I couldn't make a link: ${link.reason}.`);
  const url = linkUrl(publicOrigin(env, origin), link.token);
  return reply(
    `Private link for transcript \`${t.id}\` (valid until <t:${link.expiresAt}:D>):\n<${url}>\n` +
      'Anyone who has this address can read the summary and ask questions about the meeting, so only share it with people who should see it. ' +
      'Turn every link for this transcript off with `/unshare-transcript`.',
    { ephemeral: true },
  );
}

export async function cmdUnshareTranscript(ctx, o) {
  const { t, error } = await resolveTranscript(ctx, o);
  if (error) return error;
  const n = await revokeLinks(ctx.db, t.id, ctx.nowSec);
  return reply(
    n
      ? `Turned off ${n} link${n === 1 ? '' : 's'} for transcript \`${t.id}\`. Anyone using an old address now sees "not available". Run \`/share-transcript\` to make a new one.`
      : `Transcript \`${t.id}\` had no active links.`,
    { ephemeral: true },
  );
}
