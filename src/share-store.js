// Private share links for transcripts. A link is a random 256-bit token; only its SHA-256 hash is stored.
// Nothing here logs a token, and every lookup is by hash with bound parameters.

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, no padding
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;
export const MAX_ACTIVE_PER_TRANSCRIPT = 10;
const DAY_SEC = 86_400;
const KEEP_OLD_SEC = 30 * DAY_SEC; // expired or revoked rows are deleted after this long

const enc = new TextEncoder();

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(token))));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Days a link lasts: SHARE_LINK_DAYS (0 = no automatic links, up to 365). A bad value falls back to the default. */
export function configuredDays(env) {
  const raw = String(env?.SHARE_LINK_DAYS ?? '').trim();
  if (raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

/**
 * The public address links are built on: PUBLIC_URL if it is a valid https address (http is allowed only for
 * localhost, for development), otherwise the address the request came in on. Always an origin, no path.
 */
export function publicOrigin(env, fallbackOrigin) {
  const raw = String(env?.PUBLIC_URL ?? '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
    } catch {
      // fall through to the request's own address
    }
  }
  return fallbackOrigin;
}

export const linkUrl = (origin, token) => `${origin}/t/${token}`;

/**
 * Creates a link for a transcript. Returns { ok: true, token, expiresAt } (the token exists only in this return value;
 * it cannot be recovered later) or { ok: false, reason }.
 */
export async function createShareLink(db, { transcriptId, createdBy, days }, nowSec) {
  const d = Math.min(Math.max(Math.trunc(Number(days)) || DEFAULT_DAYS, 1), MAX_DAYS);
  // Housekeeping: forget links that ended long ago.
  await db.prepare('DELETE FROM share_links WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').bind(nowSec - KEEP_OLD_SEC, nowSec - KEEP_OLD_SEC).run();
  const active = await db
    .prepare('SELECT COUNT(*) AS n FROM share_links WHERE transcript_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(transcriptId, nowSec)
    .first();
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_TRANSCRIPT) {
    return { ok: false, reason: `this transcript already has ${MAX_ACTIVE_PER_TRANSCRIPT} active links` };
  }
  const token = newToken();
  const expiresAt = nowSec + d * DAY_SEC;
  await db
    .prepare('INSERT INTO share_links (token_hash, transcript_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashToken(token), transcriptId, String(createdBy), nowSec, expiresAt)
    .run();
  return { ok: true, token, expiresAt };
}

/** The transcript a live (not expired, not revoked) token opens (summary, not full text), or null. Same answer for every kind of "no". */
export async function findSharedTranscript(db, token, nowSec) {
  if (!TOKEN_RE.test(String(token))) return null;
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT t.id, t.started_at, t.duration_sec, t.speakers, t.language, t.summary_text, t.actions_text, t.summary_edited, t.summary_edited_at, t.summary_version, t.embedded_at, l.expires_at, l.token_hash
       FROM share_links l JOIN transcripts t ON t.id = l.transcript_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?`,
    )
    .bind(hash, nowSec)
    .first();
  return row ?? null; // the transcript text itself is deliberately not loaded: the page only shows the summary
}

/** Counts a view. Best effort: a failure here must never stop the page loading. */
export async function recordView(db, tokenHash, nowSec) {
  try {
    await db.prepare('UPDATE share_links SET views = views + 1, last_viewed_at = ? WHERE token_hash = ?').bind(nowSec, tokenHash).run();
  } catch {
    // ignore
  }
}
