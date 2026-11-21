// Google sign-in (OAuth 2.0 authorization-code flow) for the Calendar connection.
//
// Scopes are exactly: openid, email and calendar.events.owned. Nothing else is ever requested.
// Nothing here logs. Error values returned from here never contain a code, a token or a secret: when Google rejects something,
// only its short error code (letters and underscores) is kept.
import { describeKeyProblem } from './token-crypto.js';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned'];
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * What the Worker needs for Google sign-in, or null when any piece is missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 * TOKEN_ENC_KEY (a valid 32-byte base64 key) and GOOGLE_REDIRECT_URI (all four are Worker secrets).
 */
export function googleConfig(env) {
  const clientId = String(env?.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.GOOGLE_CLIENT_SECRET ?? '').trim();
  const redirectUri = String(env?.GOOGLE_REDIRECT_URI ?? '').trim();
  if (!clientId || !clientSecret || !redirectUri || describeKeyProblem(env?.TOKEN_ENC_KEY)) return null;
  return { clientId, clientSecret, redirectUri, encKey: env.TOKEN_ENC_KEY };
}

/** The part of the configuration slash commands may see: no secret and no key. null when sign-in is not set up. */
export function publicGoogleConfig(env) {
  const c = googleConfig(env);
  return c ? { clientId: c.clientId, redirectUri: c.redirectUri } : null;
}

/** The link a PM clicks to sign in. `state` is the one-time code. */
export function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline'); // needed to get a refresh token
  u.searchParams.set('prompt', 'consent'); // makes Google send the refresh token every time
  u.searchParams.set('state', state);
  return u.toString();
}

const safeErrorCode = (v) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : 'unknown');

/**
 * Reads the account from the id_token Google returned. The token came straight from Google's token endpoint over TLS in answer to
 * our own request, so (as the OpenID Connect spec allows in that case) its signature is not checked; the audience, issuer and
 * expiry still are.
 */
function readIdToken(idToken, clientId, nowSec) {
  try {
    const part = String(idToken).split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    if (claims.aud !== clientId) return null;
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return null;
    if (!(Number(claims.exp) > nowSec)) return null;
    const email = String(claims.email ?? '').trim().toLowerCase();
    if (!email || email.length > 254 || claims.email_verified === false) return null;
    return { email };
  } catch {
    return null;
  }
}

/**
 * One POST to Google's token endpoint. Never throws. Returns { network: true, error } when Google could not be reached in time,
 * otherwise { ok, status, body } (body is the parsed JSON, or null). The caller decides what an answer means.
 */
async function postToken(form, fetchImpl) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (e) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted;
    return { network: true, error: timedOut ? 'Google did not answer in time' : 'could not reach Google' };
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Trades the one-time Google code for tokens. Never throws. Returns
 *   { ok: true, refreshToken (string or null), scopes: [...], email }
 *   { ok: false, kind: 'network' | 'rejected' | 'unusable', error }   (error is a short, secret-free description)
 */
export async function exchangeCode({ clientId, clientSecret, redirectUri, code, nowSec, fetchImpl }) {
  const t = await postToken(
    { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri },
    fetchImpl,
  );
  if (t.network) return { ok: false, kind: 'network', error: t.error };
  if (!t.ok) {
    return { ok: false, kind: t.status >= 500 ? 'network' : 'rejected', error: `Google answered HTTP ${t.status} (${safeErrorCode(t.body?.error)})` };
  }
  const who = t.body?.id_token ? readIdToken(t.body.id_token, clientId, nowSec) : null;
  if (!who) return { ok: false, kind: 'unusable', error: 'Google did not return a usable account identity' };
  return {
    ok: true,
    refreshToken: typeof t.body.refresh_token === 'string' && t.body.refresh_token ? t.body.refresh_token : null,
    scopes: String(t.body.scope ?? '').split(/\s+/).filter(Boolean),
    email: who.email,
  };
}

/**
 * Trades a refresh token for a short-lived access token. Never throws, and the error text never contains a token. Returns
 *   { ok: true, accessToken, expiresInSec }
 *   { ok: false, kind, error } where kind is
 *     'invalid_grant'  Google no longer accepts this sign-in (revoked, expired, password reset...). Retrying cannot help.
 *     'config'         Google refused the bot's own client settings (invalid_client and similar). Retrying cannot help.
 *     'transient'      Google unreachable, slow, rate-limiting, erroring, or an unusable answer. Worth trying again.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const t = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }, fetchImpl);
  if (t.network) return { ok: false, kind: 'transient', error: t.error };
  if (!t.ok) {
    const code = safeErrorCode(t.body?.error);
    if (code === 'invalid_grant') return { ok: false, kind: 'invalid_grant', error: 'Google no longer accepts the saved sign-in (invalid_grant)' };
    if (t.status >= 500 || t.status === 429) return { ok: false, kind: 'transient', error: `Google answered HTTP ${t.status}` };
    return { ok: false, kind: 'config', error: `Google refused the bot's request (HTTP ${t.status}, ${code})` };
  }
  const accessToken = t.body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return { ok: false, kind: 'transient', error: 'Google did not return an access token' };
  return { ok: true, accessToken, expiresInSec: Number(t.body.expires_in) > 0 ? Number(t.body.expires_in) : 3600 };
}

/**
 * Revokes a refresh token at Google, which ends the whole sign-in (the app disappears from the person's Google permissions page).
 * Never throws, and the error text never contains the token. Returns
 *   { ok: true, alreadyInvalid }   alreadyInvalid = Google said the token was already expired or revoked: nothing left to revoke
 *   { ok: false, kind: 'transient' | 'rejected', error }
 */
export async function revokeToken({ token, fetchImpl }) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: controller.signal,
    });
  } catch (e) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted;
    return { ok: false, kind: 'transient', error: timedOut ? 'Google did not answer in time' : 'could not reach Google' };
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return { ok: true, alreadyInvalid: false };
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (res.status === 400 && safeErrorCode(body?.error) === 'invalid_token') return { ok: true, alreadyInvalid: true };
  if (res.status >= 500 || res.status === 429) return { ok: false, kind: 'transient', error: `Google answered HTTP ${res.status}` };
  return { ok: false, kind: 'rejected', error: `Google answered HTTP ${res.status} (${safeErrorCode(body?.error)})` };
}
