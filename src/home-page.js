// The page at "/": whether the bot is up, and a few lines about it. Same look and layout as the transcript page (src/share-page.js).
//
// What "status" can honestly say. The Worker answers every slash command over HTTP, so if this page loads, commands and reminders
// are being served. It can also test its own database. It cannot see Discord's own state (this bot has no always-on connection:
// only the recorder logs in, and only while a recording runs). The feature rows only say whether each optional feature is set up on
// this Worker; they never show a value, a name or a count.
import { SECURITY_HEADERS, esc, shell } from './share-page.js';

export const HOME_HEADERS = SECURITY_HEADERS; // private, no-store, noindex: a status page must be fresh and is not for search

/**
 * Checks the Worker's own database with a trivial query. { ok: true } or { ok: false }. Never throws, never shows the error.
 * `timeoutMs` keeps a hung database from hanging the page.
 */
export async function checkDatabase(db, { timeoutMs = 3000 } = {}) {
  if (!db || typeof db.prepare !== 'function') return { ok: false };
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const row = await Promise.race([db.prepare('SELECT 1 AS ok').first(), timeout]);
    return { ok: row?.ok === 1 };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const DOT = (kind) => `<span class="dot ${kind}" aria-hidden="true"></span>`;

/** status: { database: boolean, calendar: boolean, recording: boolean, questions: boolean } */
export function homePage(status) {
  const row = (label, state, kind) => `<li>${DOT(kind)}<span>${esc(label)}</span><span class="state">${esc(state)}</span></li>`;
  const feature = (label, on) => row(label, on ? 'On' : 'Not set up', on ? 'good' : 'off');

  const allUp = Boolean(status.database);
  const chips =
    `<span class="chip">${DOT(allUp ? 'good' : 'bad')}${allUp ? 'Online' : 'Problem with the database'}</span>` +
    `<span class="chip">Database ${status.database ? 'OK' : 'unavailable'}</span>`;

  const body =
    '<div class="layout solo"><main class="note"><div class="article">' +
    '<h1>VC Bot</h1>' +
    `<div class="chips">${chips}</div>` +
    '<h2><span class="hash" aria-hidden="true">#</span>Status</h2>' +
    '<ul class="status">' +
    row('Commands and reminders', 'Online', 'good') +
    row('Database', status.database ? 'OK' : 'Unavailable', status.database ? 'good' : 'bad') +
    feature('Google Calendar sync', status.calendar) +
    feature('Recording and summaries', status.recording) +
    feature('Questions about a meeting', status.questions) +
    '</ul>' +
    '<p class="fine">The bot answers commands through this page\'s server, so it only shows as online in Discord\'s member list while a recording is running. That is normal.</p>' +
    '<h2><span class="hash" aria-hidden="true">#</span>What it does</h2>' +
    '<ul>' +
    '<li>Schedules meetings and posts reminders in your Discord server.</li>' +
    '<li>Optionally adds those meetings to an organiser\'s Google Calendar.</li>' +
    '<li>Records a voice-channel meeting when someone starts it, then posts a transcript and a summary with action items, and gives a private page where you can read the summary and ask questions about the meeting.</li>' +
    '</ul>' +
    '<h2><span class="hash" aria-hidden="true">#</span>Using it</h2>' +
    '<p>Everything is done with slash commands in Discord: type <code>/</code> in your server to see them. For example <code>/new-meeting</code>, <code>/upcoming-meetings</code>, <code>/start-recording</code> and <code>/stop-recording</code>.</p>' +
    '<p class="fine"><a href="/privacy">Privacy policy</a></p>' +
    '</div></main></div>';
  return shell('VC Bot', body);
}
