// The public privacy policy at /privacy. Every statement here is checked against the code (see test/privacy.test.js and the
// notes next to each section); if the code changes what is stored or sent, change this text with it.
//
// Facts it relies on:
//  * Google Calendar goes through a per-organiser Google Apps Script web app (Code.gs, src/bridge.js). The Worker stores NO Google
//    sign-in token: only the script URL and the account address the script reports (calendar_accounts, migration 0003).
//  * /calendar disconnect deletes that row and stops syncing (src/store.js deleteCalendarAccount). It does not revoke anything
//    at Google and does not delete events already created.
//  * The script only creates, reads back (by event id) and cancels events the bot made, and reads the calendar's own address.
//  * What is sent to Google: src/calendar-sync.js buildPayload.
import { SECURITY_HEADERS, esc, shell } from './share-page.js';

export const PRIVACY_UPDATED = '20 November 2026';

/** The privacy page is public and meant to be found: no noindex, and it may be cached for an hour. Everything else is as strict as the other pages. */
export const PRIVACY_HEADERS = (() => {
  const h = { ...SECURITY_HEADERS };
  delete h['X-Robots-Tag'];
  h['Cache-Control'] = 'public, max-age=3600';
  return h;
})();

const EMAIL_RE = /^[^\s@<>"'`,;()[\]\\]+@[^\s@<>"'`,;()[\]\\]+\.[^\s@<>"'`,;()[\]\\]+$/;

/** Contact address from the PRIVACY_CONTACT_EMAIL setting, or null when it is missing or not an email address. */
export function cleanContactEmail(value) {
  const v = String(value ?? '').trim();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

export function privacyPage({ contactEmail = null } = {}) {
  const email = cleanContactEmail(contactEmail);
  const contact = email
    ? `Email <a href="mailto:${esc(email)}">${esc(email)}</a> to ask for your data to be deleted or to ask any question about this page.`
    : 'Ask the person who runs this bot in your Discord server to delete your data or to answer any question about this page. (No contact address has been configured for this page yet.)';

  const body =
    '<div class="layout solo"><main class="note"><div class="article">' +
    '<h1>Privacy policy</h1>' +
    `<p class="fine" style="margin-top:0">Last updated ${esc(PRIVACY_UPDATED)}</p>` +
    '<p>VC Bot is a private tool run for one team. In that team\'s Discord server it schedules meetings and sends reminders, it can add ' +
    'those meetings to an organiser\'s Google Calendar, and it can record, transcribe and summarise meetings held in the team\'s voice channels. ' +
    'It is not a public service. This page says what data it handles.</p>' +
    '<h2>Google Calendar</h2>' +
    '<p>Calendar sync is optional. A meeting organiser (for example a project manager) turns it on with <code>/calendar connect</code>.</p>' +
    '<ul>' +
    '<li>This tool never asks you to sign in to Google and never sees your Google password. Instead the organiser sets up their own small Google Apps Script web app, which runs as their own Google account and asks them to allow access to their Google Calendar. The bot sends requests to that script.</li>' +
    '<li>The access is used to <strong>create, edit and cancel</strong> the calendar events for meetings the organiser schedules with the bot. The script also reads back those same events, by their id, and the address of the calendar. It does not list or read your other calendar events.</li>' +
    '<li>What is sent to Google for each meeting: the title, start time, length, time zone, whether it repeats, the location text, a description with a link to the Discord channel, the guests\' email addresses, and whether to make a Google Meet link. Google emails invitations, updates and cancellations to the guests when an event is created, changed or cancelled.</li>' +
    '</ul>' +
    '<h2>What the bot stores</h2>' +
    '<ul>' +
    '<li><strong>Your calendar connection:</strong> your Discord user ID, the web address of your Apps Script, the Google account address that script reports, and when you connected. No Google password or sign-in token is stored by the bot, and nothing else from your calendar is.</li>' +
    '<li><strong>Each synced meeting:</strong> the Google event ID, the Meet link and whether the last sync worked.</li>' +
    '<li><strong>Guests:</strong> the email addresses organisers add to guest teams, with the team name and the Discord server.</li>' +
    '<li><strong>Meetings:</strong> name, time, time zone, location, length, repeat, the channel for reminders, which roles to mention, and who created it. Also each person\'s chosen time zone.</li>' +
    '</ul>' +
    '<p>All of this is kept in the bot\'s database, which is hosted on Cloudflare.</p>' +
    '<h2>Recordings, transcripts and summaries</h2>' +
    '<p>This happens only when a person in the team starts a recording, or when a scheduled meeting is set to start one in a voice channel the team\'s admins have set up. The bot renames itself <code>[REC]</code> and posts a notice in the voice channel when it joins.</p>' +
    '<ul>' +
    '<li>The audio is processed on a temporary GitHub Actions machine and deleted when that run ends. If the server has chosen a backup channel, the audio files are posted there in Discord. If the machine cannot transcribe some audio (for example it is too slow), that audio is sent to Groq\'s speech-to-text service.</li>' +
    '<li>The transcript text is sent to Cloudflare Workers AI (or to Groq if Cloudflare cannot answer) to write a summary and to answer questions about the meeting.</li>' +
    '<li>The transcript, the summary and the speakers\' Discord display names are stored in the database. The summary can be opened on a private web page. Anyone who has that page\'s link can read the summary, ask questions about the meeting and edit the summary, so the link should be shared only with the team. Links stop working after 30 days by default.</li>' +
    '</ul>' +
    '<h2>Who sees it</h2>' +
    '<p>We do not sell your data, and we do not use it for advertising or for anything other than the features described above. It is handled only by the services that do the work: Discord (the messages and voice), Google (the calendar events you choose to create), Cloudflare (hosting, the database and AI), GitHub (it runs the recorder) and Groq (fallback speech-to-text, summaries and answers). Each handles it under its own terms.</p>' +
    '<h2>Disconnecting and deleting your data</h2>' +
    '<ul>' +
    '<li><code>/calendar disconnect</code> deletes the stored web address and account address and stops syncing. It does <strong>not</strong> delete events already in your Google Calendar, and it does not remove the script\'s permission inside your Google account. To end that access as well, delete the script\'s deployment in Apps Script (<em>Deploy &gt; Manage deployments</em>) or remove its access in your Google Account settings.</li>' +
    '<li>An organiser can remove guest email addresses with <code>/remove-team-member</code> or <code>/delete-team</code>.</li>' +
    '<li>For anything else, including transcripts and summaries, ask for deletion by contacting us (below). There is no self-service command for that today.</li>' +
    '</ul>' +
    '<h2>Contact</h2>' +
    `<p>${contact}</p>` +
    '<h2>Changes</h2>' +
    '<p>If what the bot stores or does changes, this page is updated and the date at the top changes.</p>' +
    '</div></main></div>';
  return shell('Privacy policy', body, { indexable: true });
}
