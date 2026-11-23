// Cloudflare Worker entry point.
//   fetch      – Discord interactions endpoint (slash commands)
//   scheduled  – cron triggers. Every minute: the reminder scheduler, then the Google Calendar sync.
//                Any other schedule (the weekly one in wrangler.toml): the Google sign-in keep-alive (src/calendar-keepalive.js).
import { handleInteraction } from './commands.js';
import { createBridgeClient } from './bridge.js';
import { runCalendarSync } from './calendar-sync.js';
import { createDiscordClient, verifyDiscordSignature } from './discord.js';
import { createRecorderDispatcher } from './github.js';
import { EVERY_MINUTE_CRON, runKeepAlive } from './calendar-keepalive.js';
import { disconnectGoogle } from './calendar-disconnect.js';
import { createGoogleCalendarClient } from './google-calendar.js';
import { googleConfig, publicGoogleConfig } from './google-oauth.js';
import { questionsEnabled } from './ask.js';
import { HOME_HEADERS, checkDatabase, homePage } from './home-page.js';
import { handleHttp } from './http.js';
import { runDueJobs } from './scheduler.js';

const MAX_CLOCK_SKEW_SEC = 300; // reject replayed requests older than 5 minutes

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function makeDiscord(env) {
  return createDiscordClient({ token: env.DISCORD_BOT_TOKEN, apiBase: env.DISCORD_API_BASE });
}

// Google Calendar is optional: without BRIDGE_SECRET the feature is off and nothing else is affected.
// BRIDGE_ALLOWED_HOSTS exists only so the smoke test can point at a local mock; never set it in production.
const extraBridgeHosts = (env) =>
  String(env.BRIDGE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

function makeBridge(env) {
  return env.BRIDGE_SECRET ? createBridgeClient({ secret: env.BRIDGE_SECRET, extraHosts: extraBridgeHosts(env) }) : null;
}

// Google sign-in for calendars is optional as well: without GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and a valid
// TOKEN_ENC_KEY, meetings simply are not added through it.
function makeGoogleCalendar(env) {
  const config = googleConfig(env);
  return config ? createGoogleCalendarClient({ db: env.DB, config }) : null;
}

// What slash commands may use of the Google sign-in: the public settings for building a sign-in link, and a disconnect that revokes
// the token at Google. The secrets stay inside this closure; commands never see them.
function makeGoogleForCommands(env) {
  const config = googleConfig(env);
  if (!config) return null;
  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    disconnect: (discordUserId, nowSec) => disconnectGoogle({ db: env.DB, config, discordUserId, nowSec }),
  };
}

// Recording is optional too: without GITHUB_DISPATCH_TOKEN and GITHUB_REPO, /start-recording says it is not set up.
function makeRecorder(env) {
  return createRecorderDispatcher({ token: env.GITHUB_DISPATCH_TOKEN, repo: env.GITHUB_REPO, ref: env.GITHUB_REF });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
      // The home page: whether the bot is up, and which optional features are set up. No values, names or counts are shown.
      const status = { database: (await checkDatabase(env.DB)).ok, calendar: Boolean(makeBridge(env)) || Boolean(publicGoogleConfig(env)), recording: Boolean(makeRecorder(env)), questions: questionsEnabled(env) };
      return new Response(request.method === 'HEAD' ? null : homePage(status), { headers: HOME_HEADERS });
    }

    // Recorder endpoints (and later the share pages). They use their own secret, not Discord's signature.
    const routed = await handleHttp(request, env, ctx, Math.floor(Date.now() / 1000));
    if (routed) return routed;

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_BOT_TOKEN || !env.DB) {
      console.error('Missing DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, or the DB binding.');
      return new Response('Server is not configured', { status: 500 });
    }

    const body = await request.text();
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const valid = await verifyDiscordSignature({
      publicKey: env.DISCORD_PUBLIC_KEY,
      signature: request.headers.get('X-Signature-Ed25519'),
      timestamp,
      body,
    });
    if (!valid) return new Response('Invalid request signature', { status: 401 });

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(timestamp)) > MAX_CLOCK_SKEW_SEC) {
      return new Response('Stale request', { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    try {
      const response = await handleInteraction(interaction, {
        db: env.DB,
        discord: makeDiscord(env),
        bridge: makeBridge(env),
        google: makeGoogleForCommands(env), // sign-in settings (no secret) and the /calendar Disconnect button; null = Google sign-in is not set up
        recorder: makeRecorder(env),
        defer: (promise) => ctx.waitUntil(promise),
        extraHosts: extraBridgeHosts(env),
        env: { PUBLIC_URL: env.PUBLIC_URL, SHARE_LINK_DAYS: env.SHARE_LINK_DAYS }, // only what the share commands need
        origin: url.origin,
        nowSec,
      });
      return json(response);
    } catch (e) {
      console.error('interaction failed:', e?.stack ?? e);
      const detail = String(e?.message ?? e).slice(0, 300);
      return json({
        type: 4,
        data: {
          content: `Something went wrong on my side: ${detail}
Please try again. If it keeps happening, tell the server admin.`,
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      });
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.DISCORD_BOT_TOKEN || !env.DB) {
      console.error('Scheduler skipped: missing DISCORD_BOT_TOKEN or DB binding.');
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const discord = makeDiscord(env);

    // The weekly trigger only refreshes Google sign-ins; the reminders and the sync belong to the every-minute trigger.
    if (event?.cron && event.cron !== EVERY_MINUTE_CRON) {
      const config = googleConfig(env);
      if (!config) {
        console.log('calendar keep-alive skipped: Google sign-in is not set up on this bot.');
        return;
      }
      ctx.waitUntil(
        runKeepAlive({ db: env.DB, discord, config, nowSec }).catch((e) => console.error(`calendar keep-alive failed: ${String(e?.name ?? 'Error').slice(0, 40)}`)),
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        // Reminders are time-critical, so they run first; each step has its own try/catch so one cannot block the other.
        try {
          const summary = await runDueJobs({ db: env.DB, discord, nowSec, recorder: makeRecorder(env) });
          if (summary.claimed) console.log('scheduler:', JSON.stringify(summary));
        } catch (e) {
          console.error('scheduler failed:', e?.stack ?? e);
        }
        const bridge = makeBridge(env);
        const google = makeGoogleCalendar(env);
        if (!bridge && !google) return;
        try {
          const summary = await runCalendarSync({ db: env.DB, discord, bridge, google, nowSec });
          if (summary.claimed) console.log('calendar sync:', JSON.stringify(summary));
        } catch (e) {
          console.error('calendar sync failed:', e?.stack ?? e);
        }
      })(),
    );
  },
};
