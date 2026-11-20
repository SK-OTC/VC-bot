import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { cleanContactEmail, privacyPage, PRIVACY_HEADERS } from '../src/privacy-page.js';

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

test('it does not claim things the code does not do: no stored sign-in token, no encryption claim, no "revokes access"', () => {
  const t = text(privacyPage({}));
  assert.ok(!/refresh token/i.test(t));
  assert.ok(!/encrypt/i.test(t));
  assert.ok(!/revokes? (your )?access/i.test(t));
  assert.match(t, /does not delete events already in your Google Calendar, and it does not remove the script's permission inside your Google account/);
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
