import test from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_SCRIPT } from '../src/editor-script.js';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { cleanSummaryEdit, MAX_SUMMARY_EDIT_CHARS } from '../src/recording-store.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const DAY = 86_400;
const SECRET = 'test-shared-secret-value';
const GROQ_KEY = 'gsk_test_key_that_must_never_leak_123';
const ORIGIN = 'https://worker.example';

function groqSpy() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Sam is the owner [00:00:20].' } }] }), { status: 200 });
    }
    return real(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function setup() {
  const db = createTestDb();
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET, GROQ_API_KEY: GROQ_KEY };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const send = async (path, { method = 'GET', headers = {}, body, now = NOW } = {}) => {
    const realNow = Date.now;
    Date.now = () => now * 1000;
    try {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }), env, ctx);
      await Promise.all(waits.splice(0));
      return res;
    } finally {
      Date.now = realNow;
    }
  };
  const form = (path, fields, { headers = {}, now } = {}) =>
    send(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: new URLSearchParams(fields).toString(), now });
  return { db, env, send, form };
}

const payload = (over = {}) => ({
  id: 'abc234',
  session_id: null,
  guild_id: '222222222222222222',
  voice_channel_id: '111111111111111111',
  post_channel_id: '333333333333333333',
  transcript_message_id: '444444444444444444',
  summary_message_id: null,
  started_at: '2026-11-19T10:00:00.000Z',
  duration_sec: 600,
  speakers: [{ name: 'Alice', speaking_sec: 300 }],
  engine: 'groq whisper-large-v3',
  language: 'en',
  transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:05] Alice: the budget is forty thousand dollars\n[00:00:20] Sam: I will send the budget',
  summary_text: '**Summary**\n- Alice said the budget is forty thousand [00:00:05]\n\n**Action items**\n- Sam: send the budget [00:00:20]',
  actions_text: '- Sam: send the budget [00:00:20]',
  ...over,
});

async function stored(t, over) {
  const res = await t.send('/api/transcripts', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(payload(over)) });
  assert.equal(res.status, 200);
  return new URL((await res.json()).share_url).pathname;
}

// The transcript text lives only in its chunks (one row per ~1,500 characters); editing must never change them.
const transcriptRows = (db) => ({ chunks: db.sql('SELECT seq, text FROM transcript_chunks ORDER BY seq'), fts: db.sql("SELECT COUNT(*) AS n FROM transcript_chunks_fts WHERE transcript_chunks_fts MATCH 'budget'")[0].n });

test('cleanSummaryEdit: normalises newlines, strips control characters, refuses empty and too long', () => {
  assert.deepEqual(cleanSummaryEdit('  **Summary**\r\n- a\u0000b  '), { ok: true, text: '**Summary**\n- a b' });
  assert.equal(cleanSummaryEdit('   ').ok, false);
  assert.equal(cleanSummaryEdit(null).ok, false);
  assert.equal(cleanSummaryEdit('x'.repeat(MAX_SUMMARY_EDIT_CHARS)).ok, true);
  const long = cleanSummaryEdit('x'.repeat(MAX_SUMMARY_EDIT_CHARS + 1));
  assert.equal(long.ok, false);
  assert.ok(!JSON.stringify(long).includes('xxxx'), 'the refusal never repeats the text');
});

test('GET /t/<token>/admin shows the summary as readers see it, editable, plus the text-box fallback; the transcript is nowhere on it', async () => {
  const t = setup();
  const path = await stored(t);
  const res = await t.send(`${path}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Security-Policy'), /form-action 'self'/);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const html = await res.text();
  assert.match(html, /<h1>Meeting summary<\/h1>/);
  assert.match(html, /<div id="notes" class="notes" data-version="0"><h2><span class="hash" aria-hidden="true">#<\/span>Summary<\/h2>/, 'drawn as the reader page draws it');
  assert.match(html, /<noscript>[\s\S]*<textarea id="summary" name="summary"[^>]*>\n\*\*Summary\*\*[\s\S]*<\/noscript>/, 'the text box is the fallback without JavaScript');
  assert.ok(html.includes('Alice said the budget is forty thousand'));
  assert.ok(!html.includes('the budget is forty thousand dollars'), 'transcript text is not on the page');
  assert.ok(!html.includes('Restore the generated summary'), 'nothing to restore before an edit');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [EDITOR_SCRIPT], 'the only script is the editor, allowed by its hash');
  assert.ok(!/<a[\s>]|<img/i.test(html.replace('<a class="brand" href="/">VC Bot</a>', '')));
  // the page has no way to send transcript text anywhere: its only fields are the summary text box and the AI instruction
  const fields = [...html.matchAll(/<(?:textarea|input)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fields.includes('summary') && fields.every((f) => f === 'summary' || f === 'ai'), fields.join(','));
});

test('POST saves an edit: the public page shows it, the generated summary and the transcript are untouched', async () => {
  const t = setup();
  const path = await stored(t);
  const before = transcriptRows(t.db);
  const edited = '**Summary**\n- Alice (the CFO) said the budget is forty thousand [00:00:05]\n  - nested point';
  const res = await t.form(`${path}/admin`, { summary: edited });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), `${path}/admin?saved=1`);

  const row = t.db.sql('SELECT summary_text, summary_edited, summary_edited_at FROM transcripts')[0];
  assert.equal(row.summary_edited, edited);
  assert.equal(row.summary_edited_at, NOW);
  assert.ok(row.summary_text.includes('Alice said the budget is forty thousand'), 'the generated summary is kept');
  assert.deepEqual(transcriptRows(t.db), before, 'the transcript and its chunks are byte-identical');

  const page = await (await t.send(path)).text();
  assert.ok(page.includes('Alice (the CFO) said'));
  assert.ok(!page.includes('Sam: send the budget'), 'an edited summary replaces the whole text, including the generated action items');
  assert.match(await (await t.send(`${path}/admin?saved=1`)).text(), /<p class="ok" role="status">Saved\.<\/p>/);
});

test('restore goes back to the generated summary', async () => {
  const t = setup();
  const path = await stored(t);
  await t.form(`${path}/admin`, { summary: '**Summary**\n- something else' });
  assert.ok((await (await t.send(`${path}/admin`)).text()).includes('Restore the generated summary'));
  const res = await t.form(`${path}/admin`, { restore: '1' });
  assert.equal(res.headers.get('Location'), `${path}/admin?restored=1`);
  assert.deepEqual(t.db.sql('SELECT summary_edited, summary_edited_at FROM transcripts')[0], { summary_edited: null, summary_edited_at: null });
  assert.ok((await (await t.send(path)).text()).includes('Alice said the budget is forty thousand'));
});

test('everything shown on the admin page is escaped, including a draft that was refused', async () => {
  const t = setup();
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const path = await stored(t);
  await t.form(`${path}/admin`, { summary: `**${evil}**\n- ${evil}` });
  const html = await (await t.send(`${path}/admin`)).text();
  assert.ok(!html.includes('<script>alert') && !html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  const shown = await (await t.send(path)).text();
  assert.ok(!shown.includes('<script>alert') && !shown.includes('<img'));
  assert.equal((shown.match(/<script/g) ?? []).length, 1, 'only the page\'s own script, never the edit');
  // an empty edit is refused and the (escaped) draft comes back
  const refused = await t.form(`${path}/admin`, { summary: '   ' });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /The summary cannot be empty/);
});

test('a too-long edit is refused with a fixed message and nothing is saved', async () => {
  const t = setup();
  const path = await stored(t);
  const res = await t.form(`${path}/admin`, { summary: 'y'.repeat(MAX_SUMMARY_EDIT_CHARS + 1) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /too long/);
  assert.equal(t.db.sql('SELECT summary_edited FROM transcripts')[0].summary_edited, null);
  const huge = await t.send(`${path}/admin`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '5000000', Origin: ORIGIN }, body: 'summary=x' });
  assert.equal(huge.status, 413);
});

test('cross-site, wrong-type and unlinked posts are refused; wrong, expired and malformed links give the same "not available" page', async () => {
  const t = setup();
  const path = await stored(t);
  assert.equal((await t.form(`${path}/admin`, { summary: 'x' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.form(`${path}/admin`, { summary: 'x' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await t.send(`${path}/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' })).status, 415);
  // the browser case: the page sends no-referrer, so a same-origin post arrives with Origin: null
  assert.equal((await t.form(`${path}/admin`, { summary: '**Summary**\n- ok' }, { headers: { Origin: 'null' } })).status, 303);
  assert.equal(t.db.sql('SELECT summary_edited FROM transcripts')[0].summary_edited, '**Summary**\n- ok');

  const reference = await (await t.send(`/t/${'A'.repeat(43)}`)).text();
  for (const bad of [`/t/${'A'.repeat(43)}/admin`, `${path}x/admin`, `${path}/admin/`, `${path}//admin`, `${path}/administrator`, `/t/short/admin`]) {
    const r = await t.send(bad);
    assert.equal(r.status, 404, bad);
    assert.equal(await r.text(), reference, bad);
  }
  assert.equal((await t.form(`/t/${'A'.repeat(43)}/admin`, { summary: 'x' })).status, 404, 'editing needs a live link');
  const expired = await t.send(`${path}/admin`, { now: NOW + 31 * DAY });
  assert.equal(expired.status, 404);
  assert.equal(await expired.text(), reference);
  assert.equal((await t.form(`${path}/admin`, { summary: 'late' }, { now: NOW + 31 * DAY })).status, 404);
  assert.equal(t.db.sql('SELECT summary_edited FROM transcripts')[0].summary_edited, '**Summary**\n- ok', 'an expired link cannot edit');
});

test('an edit of one transcript never touches another', async () => {
  const t = setup();
  const a = await stored(t);
  const b = await stored(t, { id: 'def567', transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:01] Sam: other meeting', summary_text: '**Summary**\n- other' });
  await t.form(`${a}/admin`, { summary: '**Summary**\n- edited A' });
  assert.equal(t.db.sql("SELECT summary_edited FROM transcripts WHERE id = 'def567'")[0].summary_edited, null);
  assert.ok((await (await t.send(b)).text()).includes('other'));
});

test('questions are answered from the transcript excerpts PLUS the edited summary (a corrected name reaches the model)', async () => {
  const t = setup();
  const groq = groqSpy();
  try {
    const path = await stored(t);
    await t.form(`${path}/admin`, { summary: '**Summary**\n- Alicia (CFO) said the budget is forty thousand [00:00:05]' });
    const res = await t.form(path, { q: 'Who said the budget?' });
    assert.equal(res.status, 200);
    const user = groq.calls[0].messages[1].content;
    assert.match(user, /<summary>\n\*\*Summary\*\*\n- Alicia \(CFO\)/, 'the edited summary is what the model sees');
    assert.ok(!user.includes('Alice said'), 'not the generated one');
    assert.ok(!user.includes('<action_items>'), 'the generated action items are not sent beside an edited summary');
    assert.match(user, /<transcript_excerpts>[\s\S]*Alice: the budget is forty thousand dollars/, 'the original transcript is still what facts come from');
    // the prompt tells the model to take names from the summary and facts only from the excerpts
    assert.match(groq.calls[0].messages[0].content, /use its spelling of names, but take facts only from the excerpts/);

    await t.form(`${path}/admin`, { restore: '1' });
    await t.form(path, { q: 'Who said the budget?' });
    const restored = groq.calls[1].messages[1].content;
    assert.match(restored, /Alice said the budget/);
    assert.match(restored, /<action_items>/);
  } finally {
    groq.restore();
  }
});
