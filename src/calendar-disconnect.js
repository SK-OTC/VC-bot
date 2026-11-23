// The /calendar "Disconnect Google" button: revoke the token at Google, delete the stored row, stop syncing the PM's meetings.
//
//  - Revoking the refresh token ends the whole sign-in, so the app disappears from the person's Google permissions page.
//  - If Google cannot be reached, NOTHING is deleted and the PM is told to try again: deleting the stored token first would leave
//    the sign-in alive at Google with no way for the bot to revoke it.
//  - If the token cannot be read (the key changed, or the sign-in is not set up on this bot) or Google refuses to revoke it, the row
//    is still deleted and the PM is told to remove access themselves at Google.
//  - Events already on the PM's calendar are left alone. Their upcoming meetings are flagged so /upcoming-meetings shows why they
//    no longer sync, and any queued sync for them is cancelled.
//  - A sign-in link made earlier cannot be used afterwards: the PM's unused connect codes are deleted.
//  - Nothing here logs, and no returned value contains a token.
import { deleteConnection, getConnection, readRefreshToken } from './calendar-connections.js';
import { revokeToken } from './google-oauth.js';
import { flagMeetingsOwnerDisconnected } from './store.js';
import { TokenCryptoError } from './token-crypto.js';

/**
 * @param config  googleConfig(env), or null when sign-in is not set up on the bot (the token then cannot be read)
 * @returns { ok: true, outcome: 'none' }                                    no Google sign-in on record
 *       or { ok: true, outcome: 'disconnected', email, revoked, affected }  revoked: 'revoked' | 'already_invalid' | 'manual' | 'not_needed'
 *       or { ok: false, error }                                             Google could not be reached; nothing was changed
 */
export async function disconnectGoogle({ db, config, discordUserId, nowSec, fetchImpl }) {
  const conn = await getConnection(db, discordUserId);
  if (!conn) return { ok: true, outcome: 'none' };

  let revoked = 'not_needed'; // the sign-in had already been given up (a disconnected row holds no token)
  if (conn.status === 'connected') {
    let token = null;
    if (config) {
      try {
        token = await readRefreshToken({ db, encKey: config.encKey, discordUserId });
      } catch (e) {
        if (!(e instanceof TokenCryptoError)) throw e;
      }
    }
    if (!token) {
      revoked = 'manual';
    } else {
      const res = await revokeToken({ token, fetchImpl });
      if (!res.ok && res.kind === 'transient') {
        return { ok: false, error: `I could not reach Google to revoke your sign-in (${res.error}). Nothing was changed; please try again in a minute.` };
      }
      revoked = res.ok ? (res.alreadyInvalid ? 'already_invalid' : 'revoked') : 'manual';
    }
  }

  await deleteConnection(db, discordUserId);
  await db.prepare('DELETE FROM calendar_connect_codes WHERE discord_user_id = ?').bind(discordUserId).run();
  const affected = await flagMeetingsOwnerDisconnected(db, discordUserId, 'oauth');
  return { ok: true, outcome: 'disconnected', email: conn.google_email, revoked, affected };
}
