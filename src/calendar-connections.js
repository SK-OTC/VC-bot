// Storage for Google sign-ins (calendar_connections, migration 0014). Refresh tokens are encrypted before they reach the
// database and decrypted only at the moment a Google call needs them. Access tokens are never stored.
//
// Nothing here logs. Errors and return values never contain a token.
import { decryptSecret, encryptSecret } from './token-crypto.js';

// ---------- one-time sign-in codes (the OAuth "state") ----------

export const CONNECT_CODE_TTL_SEC = 600; // 10 minutes
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const base64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const CONNECT_CODE_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

async function hashCode(code) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(code)))));
}

/**
 * Makes a one-time code for this PM and server and returns it (plain text, once: only its hash is stored). Any earlier unused
 * code of the same PM is cancelled, so only the newest link works.
 */
export async function createConnectCode(db, { discordUserId, teamId, nowSec }) {
  const code = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare('DELETE FROM calendar_connect_codes WHERE expires_at < ?').bind(nowSec - 86400), // housekeeping
    db.prepare('UPDATE calendar_connect_codes SET used = 1 WHERE discord_user_id = ? AND used = 0').bind(discordUserId),
    db
      .prepare('INSERT INTO calendar_connect_codes (code, discord_user_id, team_id, expires_at, used) VALUES (?, ?, ?, ?, 0)')
      .bind(await hashCode(code), discordUserId, teamId, nowSec + CONNECT_CODE_TTL_SEC),
  ]);
  return code;
}

/**
 * Uses up a code: returns { discordUserId, teamId } if it exists, is unused and has not expired (and marks it used in the same
 * statement, so two requests cannot both succeed), otherwise null.
 */
export async function consumeConnectCode(db, code, nowSec) {
  if (!CONNECT_CODE_RE.test(String(code ?? ''))) return null;
  const { results } = await db
    .prepare(
      `UPDATE calendar_connect_codes SET used = 1
       WHERE code = ? AND used = 0 AND expires_at > ?
       RETURNING discord_user_id, team_id`,
    )
    .bind(await hashCode(code), nowSec)
    .all();
  return results[0] ? { discordUserId: results[0].discord_user_id, teamId: results[0].team_id } : null;
}

export async function getConnection(db, discordUserId) {
  return (await db.prepare('SELECT * FROM calendar_connections WHERE discord_user_id = ?').bind(discordUserId).first()) ?? null;
}

/**
 * Stores a freshly issued refresh token for a PM. A PM who is already connected is refused (returns
 * { ok: false, reason: 'already-connected' }) and their existing token is left untouched: Google silently retires the oldest
 * token after 100 per account per app, so replacing tokens needlessly would eventually break a working sign-in.
 * A row left `disconnected` (revoked, or Google rejected the token) is overwritten.
 */
export async function saveRefreshToken({ db, encKey, discordUserId, teamId, googleEmail, refreshToken, nowSec }) {
  const sealed = await encryptSecret(encKey, refreshToken, discordUserId);
  const res = await db
    .prepare(
      `INSERT INTO calendar_connections
         (discord_user_id, team_id, google_email, encrypted_refresh_token, iv, status, token_issued_at, last_refresh_at, last_refresh_result)
       VALUES (?, ?, ?, ?, ?, 'connected', ?, NULL, NULL)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         team_id = excluded.team_id, google_email = excluded.google_email,
         encrypted_refresh_token = excluded.encrypted_refresh_token, iv = excluded.iv,
         status = 'connected', token_issued_at = excluded.token_issued_at,
         last_refresh_at = NULL, last_refresh_result = NULL
       WHERE calendar_connections.status = 'disconnected'`,
    )
    .bind(discordUserId, teamId, googleEmail, sealed.ciphertext, sealed.iv, nowSec)
    .run();
  return res.meta.changes > 0 ? { ok: true } : { ok: false, reason: 'already-connected' };
}

/**
 * The PM's refresh token in plain text, or null when they are not connected. Throws TokenCryptoError if it cannot be decrypted
 * (the key was changed, or the row was tampered with). Call this only right before using the token.
 */
export async function readRefreshToken({ db, encKey, discordUserId }) {
  const row = await getConnection(db, discordUserId);
  if (!row || row.status !== 'connected') return null;
  return decryptSecret(encKey, { ciphertext: row.encrypted_refresh_token, iv: row.iv }, discordUserId);
}

/**
 * Marks a connected PM disconnected and wipes the stored token. The row stays so /calendar can say what happened.
 * Returns true only if this call made the change (false when they were not connected), so a caller can tell the PM exactly once.
 */
export async function markDisconnected(db, discordUserId, result, nowSec) {
  const res = await db
    .prepare(
      `UPDATE calendar_connections
       SET status = 'disconnected', encrypted_refresh_token = NULL, iv = NULL, last_refresh_at = ?, last_refresh_result = ?
       WHERE discord_user_id = ? AND status = 'connected'`,
    )
    .bind(nowSec, String(result).slice(0, 200), discordUserId)
    .run();
  return res.meta.changes > 0;
}

/** Records the outcome of a token refresh. `result` must be a short, token-free description. */
export async function recordRefresh(db, discordUserId, result, nowSec) {
  await db
    .prepare('UPDATE calendar_connections SET last_refresh_at = ?, last_refresh_result = ? WHERE discord_user_id = ?')
    .bind(nowSec, String(result).slice(0, 200), discordUserId)
    .run();
}

export async function deleteConnection(db, discordUserId) {
  await db.prepare('DELETE FROM calendar_connections WHERE discord_user_id = ?').bind(discordUserId).run();
}
