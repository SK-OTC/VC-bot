// Gets a short-lived Google access token for one project manager, at the moment a Google call is about to be made.
//
//  - The refresh token is decrypted here, used once, and dropped. The access token is returned to the caller and NEVER stored
//    (not in the database, not in a cache): every call that needs one asks again.
//  - A connection is only used for the server it was made in (team_id). A different server gets { kind: 'wrong_team' } and no call
//    to Google, so one team's calendar is never touched on behalf of another.
//  - invalid_grant (the PM revoked access, or Google expired the sign-in) is NOT retried: it is returned as kind 'invalid_grant'
//    for the failure path (step 5) to handle. Transient trouble (Google unreachable, slow, 5xx, 429) is retried once after a short
//    pause, then returned as kind 'transient' with retryable: true so the caller can try again later.
//  - Nothing here logs, and no returned message contains a token, the key or a secret.
import { getConnection, readRefreshToken, recordRefresh } from './calendar-connections.js';
import { refreshAccessToken } from './google-oauth.js';
import { TokenCryptoError } from './token-crypto.js';

export const RETRY_BACKOFF_MS = 1000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MESSAGES = {
  not_connected: 'Your Google Calendar is not connected. Run `/calendar`.',
  wrong_team: 'Your Google Calendar was connected in a different server, so it is not used for this one.',
  decrypt: 'The saved Google sign-in could not be read (the bot\'s encryption key may have changed). Reconnect with `/calendar`.',
  invalid_grant: 'Google no longer accepts your saved sign-in (it was revoked or has expired). Reconnect with `/calendar`.',
  config: 'Google refused the bot\'s own settings (GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET). Tell the server admin.',
};

const fail = (kind, error, retryable = false) => ({ ok: false, kind, retryable, error });

/**
 * @param config  googleConfig(env): { clientId, clientSecret, encKey, ... }
 * @param teamId  the server (guild) the work is for. Required: a connection made in another server is refused.
 * @returns { ok: true, accessToken, expiresInSec }
 *       or { ok: false, kind: 'not_connected' | 'wrong_team' | 'decrypt' | 'invalid_grant' | 'config' | 'transient', retryable, error }
 */
export async function getAccessToken({ db, config, discordUserId, teamId, nowSec, fetchImpl, sleep = defaultSleep, backoffMs = RETRY_BACKOFF_MS }) {
  const conn = await getConnection(db, discordUserId);
  if (!conn || conn.status !== 'connected') return fail('not_connected', MESSAGES.not_connected);
  if (!teamId || conn.team_id !== teamId) return fail('wrong_team', MESSAGES.wrong_team);

  let refreshToken;
  try {
    refreshToken = await readRefreshToken({ db, encKey: config.encKey, discordUserId });
  } catch (e) {
    if (e instanceof TokenCryptoError) {
      await note(db, discordUserId, 'error: stored token cannot be decrypted', nowSec);
      return fail('decrypt', MESSAGES.decrypt);
    }
    throw e;
  }
  if (!refreshToken) return fail('not_connected', MESSAGES.not_connected);

  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await refreshAccessToken({ clientId: config.clientId, clientSecret: config.clientSecret, refreshToken, fetchImpl });
    if (last.ok) {
      await note(db, discordUserId, 'ok', nowSec);
      return { ok: true, accessToken: last.accessToken, expiresInSec: last.expiresInSec };
    }
    if (last.kind !== 'transient' || attempt === 2) break;
    await sleep(backoffMs);
  }

  await note(db, discordUserId, last.kind === 'invalid_grant' ? 'invalid_grant' : `error: ${last.kind}: ${last.error}`, nowSec);
  if (last.kind === 'invalid_grant') return fail('invalid_grant', MESSAGES.invalid_grant);
  if (last.kind === 'config') return fail('config', MESSAGES.config);
  return fail('transient', `Could not refresh your Google sign-in (${last.error}). This is usually temporary and is retried.`, true);
}

/** Records the outcome on the connection. A failure to write this note must never lose a good result, so it is only warned about. */
async function note(db, discordUserId, result, nowSec) {
  try {
    await recordRefresh(db, discordUserId, result, nowSec);
  } catch {
    console.warn('calendar access: could not record the refresh result');
  }
}
