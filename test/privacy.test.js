import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { cleanContactEmail, privacyPage, PRIVACY_HEADERS } from '../src/privacy-page.js';
import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../src/token-crypto.js';
import { GOOGLE_SCOPES, buildAuthUrl } from '../src/google-oauth.js';
import { addToCalendarLink } from '../src/calendar-failure.js';

const get = (path, env = {}, method = 'GET') => worker.fetch(new Request(`https://worker.example${path}`, { method }), { DB: createTestDb(), ...env }, { waitUntil() {} });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('GET /privacy is a public page: 200, HTML, cacheable, indexable, no script, no tracking', async () => {
  const res = await get('/privacy');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.equal(res.headers.get('X-Robots-Tag'), null, 'a policy page must be findable');
  assert.match(res.headers.get('Cache-Control'), /public/);
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const html = await res.text();
  assert.ok(!/<meta name="robots"/.test(html), 'no noindex tag either');
  assert.ok(!/<script|<img|<iframe|https?:\/\/[^"' ]*\.(js|css|png|woff)/i.test(html), 'no scripts, images or outside files');
  assert.match(html, /<title>Privacy policy<\/title>/);
  assert.match(html, /Last updated 20 November 2026/);
});

test('HEAD works with no body; other methods do not serve the page', async () => {
  const head = await get('/privacy', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.notEqual((await get('/privacy', {}, 'POST')).status, 200);
  assert.notEqual((await get('/privacy/extra')).status, 200);
});

test('the policy says what the app really does, in the owner\'s terms', () => {
  const t = text(privacyPage({ contactEmail: 'privacy@example.com' }));
  assert.match(t, /private tool run for one team/);
  assert.match(t, /create, edit and cancel the calendar events for meetings the organiser schedules/);
  assert.match(t, /\/calendar disconnect/);
  assert.match(t, /We do not sell your data/);
  assert.match(t, /anything other than the features described above/);
  assert.match(t, /your Discord user ID, the web address of your Apps Script, the Google account address that script reports/);
});

test('the policy describes the Google sign-in: its exact permissions, encryption, no stored access token, revoking on disconnect', () => {
  const t = text(privacyPage({}));
  assert.match(t, /asks for exactly three permissions/);
  assert.match(t, /refresh token \(stored encrypted with AES-256-GCM/);
  assert.match(t, /access tokens Google hands out are used straight away and are not stored/);
  assert.match(t, /revokes the bot's access at Google/);
  assert.match(t, /does not delete events already in your Google Calendar/);
  assert.match(t, /once a week the bot uses the stored sign-in once/);
  assert.match(t, /no email addresses/);
  assert.match(t, /Google API Services User Data Policy/);
  // The older option is still described accurately, including that its disconnect revokes nothing at Google.
  assert.match(t, /does not remove the script's permission inside your Google account/);
});

test('the permissions the policy lists are exactly the ones the code asks Google for', () => {
  assert.deepEqual(GOOGLE_SCOPES, ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned']);
  const t = text(privacyPage({}));
  assert.ok(t.includes('https://www.googleapis.com/auth/calendar.events.owned'));
  assert.ok(t.includes('openid') && t.includes('email'));
  const authUrl = new URL(buildAuthUrl({ clientId: 'c', redirectUri: 'https://x/y', state: 's' }));
  assert.equal(authUrl.searchParams.get('scope'), GOOGLE_SCOPES.join(' '));
});

test('what is stored for a Google sign-in is exactly what the policy lists: the token only encrypted, no access token column', () => {
  const db = createTestDb();
  const cols = db.sql("PRAGMA table_info('calendar_connections')").map((c) => c.name).sort();
  assert.deepEqual(cols, ['discord_user_id', 'encrypted_refresh_token', 'google_email', 'iv', 'last_refresh_at', 'last_refresh_result', 'status', 'team_id', 'token_issued_at']);
  assert.ok(!cols.some((c) => /access/.test(c)), 'there is no place to keep an access token');
  const codes = db.sql("PRAGMA table_info('calendar_connect_codes')").map((c) => c.name).sort();
  assert.deepEqual(codes, ['code', 'discord_user_id', 'expires_at', 'team_id', 'used']);
});

test('the encryption claim is real: AES-256-GCM with a 32-byte key, and the token is not stored as it was given', async () => {
  const source = readFileSync(new URL('../src/token-crypto.js', import.meta.url), 'utf8');
  assert.match(source, /AES-GCM/);
  assert.match(source, /KEY_BYTES = 32/);
  const key = randomBytes(32).toString('base64');
  const sealed = await encryptSecret(key, 'plain-token-value', 'u1');
  assert.ok(!JSON.stringify(sealed).includes('plain-token-value'));
});

test('the Calendar API is only used on the bot\'s own events by id (plus creating them): nothing lists or searches the calendar', () => {
  const source = readFileSync(new URL('../src/google-calendar.js', import.meta.url), 'utf8');
  assert.ok(!/calendarList|timeMin|timeMax|freeBusy|privateExtendedProperty|q=|syncToken|singleEvents/.test(source));
  // every GET names an event id, every POST is the single insert, and the only other calls are PATCH and DELETE
  const gets = [...source.matchAll(/request\('GET', ([^,]+),/g)].map((m) => m[1]);
  assert.ok(gets.length >= 2 && gets.every((g) => g.startsWith('eventUrl(')), gets.join(' | '));
  assert.equal([...source.matchAll(/request\('POST'/g)].length, 1);
});

test('disconnecting really revokes at Google before it deletes anything', () => {
  const source = readFileSync(new URL('../src/calendar-disconnect.js', import.meta.url), 'utf8');
  const revoke = source.indexOf('await revokeToken(');
  const del = source.indexOf('await deleteConnection(');
  assert.ok(revoke > 0 && del > revoke, 'revoke comes first');
});

test('the weekly check exists and the channel link carries no guest address', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.ok(toml.includes('"0 6 * * 1"'), 'a weekly cron trigger');
  const link = addToCalendarLink({ id: 1, name: 'Sync', guild_id: '1', channel_id: '2', start_at: 1_800_000_000, duration_min: 60, timezone: 'UTC', repeat: 'none' }, []);
  assert.equal(new URL(link.url).searchParams.get('add'), null);
});

test('the contact line: a valid address becomes a mailto link; a missing or odd value falls back to "ask the person who runs this"', () => {
  const ok = privacyPage({ contactEmail: ' privacy@example.com ' });
  assert.ok(ok.includes('<a href="mailto:privacy@example.com">privacy@example.com</a>'));
  for (const bad of [undefined, '', 'not an email', 'a@b', 'x"><script>alert(1)</script>@evil.example', 'a@b.co\nBcc: x@y.z', 'javascript:alert(1)']) {
    const html = privacyPage({ contactEmail: bad });
    assert.ok(!html.includes('mailto:'), String(bad));
    assert.ok(!html.includes('<script>alert'), String(bad));
    assert.match(html, /Ask the person who runs this bot in your Discord server/);
  }
  assert.equal(cleanContactEmail('a'.repeat(250) + '@x.io'), null);
});

test('the Worker passes PRIVACY_CONTACT_EMAIL through', async () => {
  const html = await (await get('/privacy', { PRIVACY_CONTACT_EMAIL: 'owner@example.org' })).text();
  assert.ok(html.includes('mailto:owner@example.org'));
});

test('PRIVACY_HEADERS keeps the strict headers of the other pages', () => {
  assert.equal(PRIVACY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(PRIVACY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.match(PRIVACY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
});

// ---------- the claims are tied to the code, so they cannot quietly become false ----------

test('what is stored for a calendar connection is exactly what the policy lists (no token column)', () => {
  const db = createTestDb();
  const cols = db.sql("PRAGMA table_info('calendar_accounts')").map((c) => c.name).sort();
  assert.deepEqual(cols, ['account_email', 'connected_at', 'script_url', 'user_id']);
});

test('the Apps Script never lists or searches the calendar, only works on events by id', () => {
  const script = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
  assert.ok(!/Events\.list|CalendarList|Calendars\.list|Events\.watch|CalendarApp\.getEvents|getEventsForDay/.test(script));
  assert.ok(/Calendar\.Events\.insert/.test(script) && /Calendar\.Events\.patch/.test(script) && /Calendar\.Events\.remove/.test(script));
});
