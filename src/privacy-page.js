// The public privacy policy at /privacy. Every statement here is checked against the code (see test/privacy.test.js and the
// notes next to each section); if the code changes what is stored or sent, change this text with it.
//
// Facts it relies on:
//  * Google sign-in (src/google-oauth.js, calendar-connections.js): exactly the scopes openid, email and calendar.events.owned.
//    The Worker stores, per organiser, the columns of calendar_connections (migration 0014): the refresh token only ENCRYPTED
//    (AES-256-GCM, src/token-crypto.js, key in a Worker secret). Access tokens are never stored (src/calendar-access.js).
//  * The Calendar API is only used to insert, read back by id, patch and delete the bot's own events (src/google-calendar.js).
//  * Once a week the stored sign-in is used once to check it still works (src/calendar-keepalive.js). If Google rejects it
//    (invalid_grant) the stored token is wiped and the organiser is messaged (src/calendar-failure.js). The channel link never
//    contains an email address; the private message to the organiser does.
//  * /calendar disconnect revokes the token at Google, then deletes the row (src/calendar-disconnect.js). It does not delete events.
//  * Older option, still supported: a per-organiser Google Apps Script web app (Code.gs, src/bridge.js). The Worker stores NO Google
//    token for it: only the script URL and the account address the script reports (calendar_accounts, migration 0003). Disconnecting
//    that deletes the row and revokes nothing at Google (src/store.js deleteCalendarAccount).
//  * What is sent to Google: src/calendar-sync.js buildPayload and src/google-calendar.js buildEventResource.
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
    '<p>Calendar sync is optional. A meeting organiser (for example a project manager) turns it on with <code>/calendar connect</code>, which gives them a private link to sign in with Google.</p>' +
    '<ul>' +
    '<li><strong>Signing in:</strong> the organiser signs in on Google\'s own page and chooses what to allow. The bot never sees their Google password. It asks for exactly three permissions: to know which Google account it is (<code>openid</code> and <code>email</code>) and to manage events on calendars the organiser owns (<code>https://www.googleapis.com/auth/calendar.events.owned</code>). While this app is unverified, Google shows an &quot;unverified app&quot; warning.</li>' +
    '<li><strong>What the access is used for:</strong> to <strong>create, edit and cancel</strong> the calendar events for meetings the organiser schedules with the bot, on their primary calendar. To change or cancel an event the bot reads that same event back, by its id. It does not list or read any other events in the calendar.</li>' +
    '<li>What is sent to Google for each meeting: the title, start time, length, time zone, whether it repeats, the location text, a description with a link to the Discord channel, the bot\'s own number for the meeting (as a private tag on the event), the guests\' email addresses, and whether to make a Google Meet link. Google emails invitations, updates and cancellations to the guests when an event is created, changed or cancelled.</li>' +
    '<li><strong>Checking the sign-in:</strong> once a week the bot uses the stored sign-in once to check that it still works. If Google says it no longer does (for example the organiser removed the bot\'s access in their Google account), the bot deletes the stored sign-in and sends the organiser a private message with a link to sign in again. It also posts a link in the meeting\'s channel that anyone can use to add that meeting to their own calendar; that link holds the meeting\'s title, time, location and a link to the Discord channel, and no email addresses. The private message to the organiser can hold a similar link that also lists the guests.</li>' +
    '<li><strong>Older option:</strong> instead of signing in with Google, an organiser can connect their own small Google Apps Script web app, which runs as their own Google account and asks them to allow access to their Google Calendar. The bot sends requests to that script and never receives a Google sign-in token. The script also reads back those same events, by their id, and the address of the calendar. It does not list or read your other calendar events.</li>' +
    '</ul>' +
    '<p>The bot\'s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>' +
    '<h2>What the bot stores</h2>' +
    '<ul>' +
    '<li><strong>Your Google sign-in:</strong> your Discord user ID, the Discord server you connected it in, the Google account address, the sign-in\'s refresh token (stored <strong>encrypted</strong> with AES-256-GCM; the encryption key is kept in the bot\'s private settings, not in the database), when you connected, and when it was last checked and whether that worked. The short-lived access tokens Google hands out are used straight away and are not stored. Nothing else from your calendar is stored.</li>' +
    '<li><strong>Sign-in links:</strong> a one-time code for each link (only a hash of it is stored), with who it is for, which server and when it expires. It stops working after 10 minutes or once used.</li>' +
    '<li><strong>Your Apps Script connection (older option):</strong> your Discord user ID, the web address of your Apps Script, the Google account address that script reports, and when you connected. No Google password or sign-in token is stored by the bot for this option.</li>' +
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
    '<li><code>/calendar disconnect</code> revokes the bot\'s access at Google, so it disappears from your Google Account\'s permissions page, and then deletes your stored sign-in and connection record. If Google cannot be reached it changes nothing and asks you to try again. It does <strong>not</strong> delete events already in your Google Calendar. You can also remove the bot\'s access yourself at any time at <a href="https://myaccount.google.com/permissions" rel="noreferrer">myaccount.google.com/permissions</a>.</li>' +
    '<li>For the older Apps Script option, <code>/calendar disconnect</code> deletes the stored web address and account address and stops syncing. It does <strong>not</strong> delete events already in your Google Calendar, and it does not remove the script\'s permission inside your Google account. To end that access as well, delete the script\'s deployment in Apps Script (<em>Deploy &gt; Manage deployments</em>) or remove its access in your Google Account settings.</li>' +
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
