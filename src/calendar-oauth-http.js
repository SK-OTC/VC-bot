// GET /oauth/google/callback: where Google sends the PM back after they approve (or refuse) the sign-in.
//
// The address carries a Google code and our one-time state, so the page is served with no-store and no-referrer, and nothing
// here is ever logged except fixed words. Order of work (each step stops the flow with a friendly page):
//   1. state must exist, be unused and unexpired; it is marked used straight away, whatever happens next
//   2. the PM must not already be connected (we refuse BEFORE asking Google for another token, so no token churn)
//   3. exchange the code, require a refresh token, the calendar permission and a verified email
//   4. store the refresh token encrypted; the access token is dropped
import { consumeConnectCode, getConnection, saveRefreshToken } from './calendar-connections.js';
import { CALENDAR_SCOPE, exchangeCode, googleConfig } from './google-oauth.js';
import { createDiscordClient } from './discord.js';

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pageHtml(title, paragraphs) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1f2328}h1{font-size:1.4rem}</style>' +
    `</head><body><h1>${escapeHtml(title)}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`
  );
}

const respond = (method, status, title, paragraphs) =>
  new Response(method === 'HEAD' ? null : pageHtml(title, paragraphs), { status, headers: HEADERS });

const RETRY = 'Go back to Discord and run <code>/calendar connect</code> for a fresh link.';

/** deps (tests only): { fetchImpl, discord }. */
export async function handleGoogleCallback(request, env, ctx, url, nowSec, deps = {}) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...HEADERS, Allow: 'GET, HEAD' } });
  }
  const say = (status, title, paragraphs) => respond(method, status, title, paragraphs);

  const config = googleConfig(env);
  if (!config || !env.DB) {
    return say(503, 'Google sign-in is not set up', ['This bot has not been set up for Google sign-in yet. Ask the server admin.']);
  }

  try {
    // 1. The one-time code. Used up immediately, even if the PM refused or something below fails.
    const claim = await consumeConnectCode(env.DB, url.searchParams.get('state'), nowSec);
    if (!claim) {
      return say(400, 'This link does not work', ['The sign-in link is not valid, has expired (links last 10 minutes), or was already used.', RETRY]);
    }
    if (url.searchParams.get('error')) {
      return say(200, 'Not connected', ['You did not approve the sign-in, so nothing was connected.', RETRY]);
    }
    const code = url.searchParams.get('code');
    if (!code) return say(400, 'This link does not work', ['Google did not send back a sign-in code.', RETRY]);

    // 2. Already connected: keep the existing token, do not ask Google for another.
    const existing = await getConnection(env.DB, claim.discordUserId);
    if (existing?.status === 'connected') {
      return say(409, 'Already connected', [
        `A Google account (${escapeHtml(existing.google_email)}) is already connected for you. Nothing was changed.`,
        'To connect a different account, run <code>/calendar disconnect</code> in Discord first, then <code>/calendar connect</code>.',
      ]);
    }

    // 3. Google.
    const got = await exchangeCode({ ...config, code, nowSec, fetchImpl: deps.fetchImpl });
    if (!got.ok) {
      console.warn(`google callback: sign-in failed (${got.kind}): ${got.error}`);
      return say(got.kind === 'network' ? 502 : 400, 'Google sign-in failed', [`Google did not complete the sign-in (${escapeHtml(got.error)}).`, RETRY]);
    }
    if (!got.scopes.includes(CALENDAR_SCOPE)) {
      return say(400, 'Calendar access was not granted', [
        'The sign-in went through, but the box that lets the bot manage calendar events was not ticked, so it cannot create meetings for you.',
        RETRY + ' This time leave every box ticked.',
      ]);
    }
    if (!got.refreshToken) {
      return say(400, 'Google did not give lasting access', [
        'Google only gives the bot lasting access the first time you approve it, and it did not this time (usually because you approved it before).',
        'Go to <a href="https://myaccount.google.com/permissions" rel="noreferrer">myaccount.google.com/permissions</a>, remove this app\'s access, then run <code>/calendar connect</code> again.',
      ]);
    }

    // 4. Store it (encrypted). The access token was never kept.
    const saved = await saveRefreshToken({
      db: env.DB,
      encKey: config.encKey,
      discordUserId: claim.discordUserId,
      teamId: claim.teamId,
      googleEmail: got.email,
      refreshToken: got.refreshToken,
      nowSec,
    });
    if (!saved.ok) {
      // Connected in another tab while this one was open. Do not revoke: revoking would end the grant the stored token uses.
      return say(409, 'Already connected', ['A Google account is already connected for you. Nothing was changed.']);
    }

    const dm = (async () => {
      const discord = deps.discord ?? createDiscordClient({ token: env.DISCORD_BOT_TOKEN, apiBase: env.DISCORD_API_BASE });
      const res = await discord.sendDirectMessage(claim.discordUserId, {
        content: `Your Google account **${got.email}** is now connected to the meeting bot.`,
      });
      if (!res.ok) console.warn(`google callback: could not send the confirmation message: ${res.error}`);
    })().catch(() => console.warn('google callback: could not send the confirmation message'));
    if (ctx?.waitUntil) ctx.waitUntil(dm);
    else await dm;

    return say(200, 'Connected', [
      `Your Google account <strong>${escapeHtml(got.email)}</strong> is connected to the meeting bot.`,
      'You can close this tab and go back to Discord.',
    ]);
  } catch (e) {
    // Only the kind of error: never its message, which could carry request details.
    console.error(`google callback error: ${String(e?.name ?? 'Error').slice(0, 40)}`);
    return say(500, 'Something went wrong', ['Something went wrong on our side and nothing was connected.', RETRY]);
  }
}
