// Weekly keep-alive for the Google sign-ins. Run by the weekly cron trigger (see wrangler.toml and src/index.js): it refreshes every
// connected PM's token once, so a sign-in that has gone bad is found (and the PM told) before a meeting needs it, and so there is a
// record of how old each token is and whether it still works.
//
//  - One log line per PM: Discord user id, token age in days, and the result. Never a token, a code, an email or a secret.
//  - A refresh that works updates last_refresh_at / last_refresh_result (done by calendar-access.js). The access token Google returns
//    is dropped at once: it is never stored or logged.
//  - invalid_grant takes the same path as a meeting that hits it (calendar-failure.js): the PM is marked disconnected, their token is
//    wiped and they are sent a fresh sign-in link. There is no meeting here, so no channel is posted to.
//  - The Workers Free plan allows 50 outbound requests per run. A PM costs at most 4 (two refresh attempts, then a DM), so at most
//    KEEPALIVE_MAX_PER_RUN PMs are done per run, oldest check first; the rest are counted as "deferred" and come first next time.
import { getAccessToken } from './calendar-access.js';
import { disconnectAndNotify } from './calendar-failure.js';

export const EVERY_MINUTE_CRON = '* * * * *';
export const KEEPALIVE_CRON = '0 6 * * 1'; // Mondays at 06:00 UTC; must match [triggers] crons in wrangler.toml
export const KEEPALIVE_MAX_PER_RUN = 10;

const DAY_SEC = 86400;

/** Which connected PMs to check now: the ones checked longest ago first (never checked = first). */
async function dueConnections(db, limit) {
  const { results } = await db
    .prepare(
      `SELECT discord_user_id, team_id, token_issued_at
       FROM calendar_connections WHERE status = 'connected'
       ORDER BY COALESCE(last_refresh_at, 0) ASC, discord_user_id ASC LIMIT ?`,
    )
    .bind(limit)
    .all();
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM calendar_connections WHERE status = 'connected'").first())?.n ?? 0;
  return { rows: results, total };
}

/**
 * Refreshes each connected PM's token once. Never throws; returns { checked, ok, revoked, failed, deferred }.
 * @param config  googleConfig(env)
 */
export async function runKeepAlive({ db, discord, config, nowSec, fetchImpl, sleep, log = console.log }) {
  const summary = { checked: 0, ok: 0, revoked: 0, failed: 0, deferred: 0 };
  const { rows, total } = await dueConnections(db, KEEPALIVE_MAX_PER_RUN);
  summary.deferred = Math.max(0, total - rows.length);

  for (const conn of rows) {
    const age = Math.max(0, Math.floor((nowSec - conn.token_issued_at) / DAY_SEC));
    const line = (result, extra = '') => log(`calendar keep-alive: user=${conn.discord_user_id} token_age_days=${age} result=${result}${extra}`);
    summary.checked++;
    try {
      const got = await getAccessToken({ db, config, discordUserId: conn.discord_user_id, teamId: conn.team_id, nowSec, fetchImpl, sleep });
      if (got.ok) {
        // The access token is not needed: the point was to prove the refresh token still works.
        summary.ok++;
        line('ok');
      } else if (got.kind === 'invalid_grant') {
        const out = await disconnectAndNotify({
          db,
          discord,
          signIn: { clientId: config.clientId, redirectUri: config.redirectUri },
          userId: conn.discord_user_id,
          teamId: conn.team_id,
          nowSec,
        });
        summary.revoked++;
        line('invalid_grant', ` disconnected=${out.transitioned} reconnect_dm=${out.dmSent ? 'sent' : 'not_sent'}`);
      } else {
        summary.failed++;
        line(`error:${got.kind}`);
        if (got.kind === 'config') {
          // The bot's own Google client settings are wrong: every other PM would fail the same way, so stop here.
          summary.deferred += rows.length - summary.checked;
          break;
        }
      }
    } catch (e) {
      // Only the kind of error: never its message.
      summary.failed++;
      line(`error:unexpected(${String(e?.name ?? 'Error').slice(0, 40)})`);
    }
  }
  log(
    `calendar keep-alive: done checked=${summary.checked} ok=${summary.ok} revoked=${summary.revoked} failed=${summary.failed} deferred=${summary.deferred}`,
  );
  return summary;
}
