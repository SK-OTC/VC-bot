// Sending the finished transcript to the Cloudflare Worker so it can be stored and searched with /transcript.
import { randomInt } from 'node:crypto';

// No look-alike characters (0/o, 1/l/i) so the code is easy to read out and type.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function shortId(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/**
 * payload fields (all required unless marked optional):
 *   id, guild_id, voice_channel_id, post_channel_id, transcript_message_id, summary_message_id (optional),
 *   started_at (ISO), duration_sec, speakers [{ name, speaking_sec }], engine, language,
 *   transcript_text, summary_text (optional), actions_text (optional), session_id (optional)
 */
export async function uploadTranscript({ url, secret, payload, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3 }) {
  if (!url || !secret) return { ok: false, reason: 'storage is not configured' };
  let last = 'unknown error';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        // The Worker may answer with a one-time private web link. It is passed back to be posted in Discord and must
        // never be logged: logs of a public repo are public.
        const body = await res.json().catch(() => null);
        const shareUrl = typeof body?.share_url === 'string' && /^https?:\/\/\S+$/.test(body.share_url) ? body.share_url : null;
        const expires = Number.isInteger(body?.share_expires_at) ? body.share_expires_at : null;
        return shareUrl ? { ok: true, shareUrl, shareExpiresAt: expires } : { ok: true };
      }
      last = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 413) break; // retrying will not help
      if (res.status === 409) return { ok: false, reason: 'id already exists', conflict: true };
    } catch (e) {
      last = `network error: ${e.message}`;
    }
    if (i < attempts) await sleep(1500 * i);
  }
  return { ok: false, reason: last };
}
