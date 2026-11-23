// Plain HTTP routes that are not Discord interactions. Returns a Response, or null to let index.js carry on
// with its normal handling (the health check and the signed Discord interactions).
//   /api/...        recorder endpoints (own secret)
//   /t/<token>      a private meeting page: summary plus "ask a question" (the token in the address is the only key)
//   /t/<token>/admin  edit the summary (the same key; no other sign-in): saved as you type, with an "Edit with AI" box.
//                     The transcript is never editable.
//   /oauth/google/callback  where Google sends a PM back after the Calendar sign-in (src/calendar-oauth-http.js)
//   /privacy        the public privacy policy (the only page crawlers are allowed to read)
//   /robots.txt     tells well-behaved crawlers to stay away from everything except /privacy
import { handleApi } from './api.js';
import { handleGoogleCallback } from './calendar-oauth-http.js';
import { GOOGLE_CALLBACK_PATH } from './google-oauth.js';
import { MAX_QUESTION_CHARS, answerQuestion, buildMessages, cleanQuestion, joinContext, questionLimits, qaUsesCloudflare, questionsEnabled, selectContext, takeQuestionSlot } from './ask.js';
import { neuronsToday, softCaps } from './meter.js';
import { secondsUntilMidnightUtc } from './neurons.js';
import { applyReplacements, buildEditMessages, changedLines, editOutputTokens, parseEditReply } from './edit-ai.js';
import { embedIfDue, semanticHits } from './semantic.js';
import { cleanSummaryEdit, clearSummaryEdit, saveSummaryEdit } from './recording-store.js';
import { PRIVACY_HEADERS, privacyPage } from './privacy-page.js';
import { SECURITY_HEADERS, adminPage, notFoundPage, renderNote, transcriptPage } from './share-page.js';
import { TOKEN_RE, findSharedTranscript, recordView } from './share-store.js';

const MAX_FORM_BYTES = 8192;
const MAX_ADMIN_FORM_BYTES = 300_000; // 30,000 characters, up to 9 bytes each once form-encoded, plus the field name
const page = (html, status = 200, extra = {}) => new Response(html, { status, headers: { ...SECURITY_HEADERS, ...extra } });
const plain = (status, text) => new Response(text, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });

// Fixed messages only: nothing from the model, the database or the request is ever put in an error line.
const MESSAGES = {
  empty: 'Type a question first.',
  paused: 'Q&A is paused until midnight UTC.',
  busyLink: "You've asked a lot of questions in a short time. Please wait a little and try again.",
  nothing: "I don't have any transcript text for this meeting, so I can't answer questions about it.",
  modelBusy: 'The assistant is busy right now. Please try again in a minute.',
  modelDown: "I couldn't get an answer just now. Please try again in a moment.",
  aiOff: 'Editing with AI is not available right now.',
  aiUnusable: "The AI's reply could not be used. Please try saying it differently.",
  aiNoChange: 'The AI did not change anything.',
  aiRefused: "The AI couldn't make this change from the notes and the transcript. Try saying it differently.",
  aiNotFound: "The AI's search words are not in the notes as whole words, so nothing was changed. Check the spelling and try again.",
  aiEmpty: 'Type what you want changed first.',
  badVersion: 'This page is out of date. Please reload it.',
};

async function handleShare(request, env, ctx, url, nowSec) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST' } });
  }
  const rest = url.pathname.slice('/t/'.length);
  const isAdmin = rest.endsWith('/admin');
  const token = isAdmin ? rest.slice(0, -'/admin'.length) : rest;
  // Anything that is not exactly a token (wrong length, extra path, odd characters) is the same plain "not available".
  if (!TOKEN_RE.test(token)) return page(notFoundPage(), 404);
  if (!env.DB) {
    console.error('Share pages need the DB binding.');
    return page(notFoundPage(), 404);
  }
  try {
    const t = await findSharedTranscript(env.DB, token, nowSec);
    if (!t) return page(notFoundPage(), 404);
    const enabled = questionsEnabled(env);
    if (isAdmin) return await handleAdmin(request, env, url, nowSec, t);
    const view = (qa = {}) => transcriptPage(t, { enabled, maxChars: MAX_QUESTION_CHARS, ...qa });

    if (method === 'POST') return await handleQuestion(request, env, ctx, url, nowSec, t, enabled, view);

    if (method === 'GET') {
      const count = recordView(env.DB, t.token_hash, nowSec);
      if (ctx?.waitUntil) ctx.waitUntil(count);
      else await count;
    }
    return page(view());
  } catch (e) {
    // Never log the token, a question or any text: only the kind of error.
    console.error(`share page error: ${String(e?.name ?? 'Error').slice(0, 40)}`);
    return page(notFoundPage(), 404);
  }
}

/**
 * Is this POST from our own page (or from something that is not a browser)? Cross-site posts are refused: a page on another
 * site must not be able to make a reader's browser ask questions.
 *
 * Our pages send `Referrer-Policy: no-referrer`, and browsers then send `Origin: null` even on a same-origin form post
 * (measured in Chrome: Origin "null" with Sec-Fetch-Site "same-origin"). So "null" is accepted only when the browser also says
 * Sec-Fetch-Site: same-origin, which a web page cannot forge. A sandboxed or redirected cross-site page sends "null" too, but
 * with Sec-Fetch-Site cross-site, so it is still refused. A real Origin must equal this address.
 */
export function isOwnPost(headers, ownOrigin) {
  const origin = headers.get('Origin');
  const site = headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  if (origin === null) return true; // no Origin at all: not a browser form post (or an old browser): nothing to compare
  if (origin === 'null') return site === 'same-origin';
  return origin === ownOrigin;
}

/**
 * /t/<token>/admin: edit the summary. The token in the address is the only key (there is no other sign-in), so whoever has the
 * link can edit. What keeps that contained: the generated summary is never overwritten (an edit is stored beside it and can be
 * undone), the transcript has no editing route at all, posts only work from this page (Origin / Sec-Fetch-Site), and
 * everything shown is escaped.
 * Posts: autosave=1 (the editor; JSON reply; refused if someone else saved since, by summary_version), ai=<instruction> (a
 * PROPOSED edit; JSON reply; nothing saved), restore=1, or the plain form (the editor's fallback without JavaScript).
 */
async function handleAdmin(request, env, url, nowSec, t) {
  if (request.method === 'POST') {
    if (!isOwnPost(request.headers, url.origin)) return plain(403, 'Forbidden');
    if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('Content-Type') ?? '')) return plain(415, 'Unsupported Media Type');
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_ADMIN_FORM_BYTES) return plain(413, 'Payload Too Large');
    const body = await request.text();
    if (body.length > MAX_ADMIN_FORM_BYTES) return plain(413, 'Payload Too Large');
    const form = new URLSearchParams(body);
    const back = (flag) => new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: `${url.pathname}?${flag}=1` } });
    if (form.has('restore')) {
      await clearSummaryEdit(env.DB, t.id);
      return back('restored');
    }
    if (form.has('autosave')) return await autosave(env, nowSec, t, form);
    if (form.has('ai')) return await aiEdit(env, nowSec, t, form);
    const cleaned = cleanSummaryEdit(form.get('summary'));
    if (!cleaned.ok) return page(adminPage(t, { error: cleaned.reason, draft: form.get('summary') ?? '' }), 400);
    await saveSummaryEdit(env.DB, t.id, cleaned.text, nowSec);
    return back('saved');
  }
  const notice = url.searchParams.get('saved') === '1' ? 'Saved.' : url.searchParams.get('restored') === '1' ? 'Restored the generated summary.' : null;
  return page(adminPage(t, { notice, aiEnabled: questionsEnabled(env) }));
}

/** The editor's autosave: { ok, version } | 409 { conflict, version } (someone else saved first) | 400 { error }. */
async function autosave(env, nowSec, t, form) {
  const cleaned = cleanSummaryEdit(form.get('summary'));
  if (!cleaned.ok) return json(400, { ok: false, error: cleaned.reason });
  const raw = String(form.get('version') ?? '');
  const version = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN; // "" would otherwise read as 0
  if (!Number.isInteger(version)) return json(400, { ok: false, error: MESSAGES.badVersion });
  const r = await saveSummaryEdit(env.DB, t.id, cleaned.text, nowSec, version);
  if (!r.ok) {
    // An out-of-date version whose text is already exactly what is stored is this editor's own earlier save whose reply was
    // lost (the connection dropped after it was written, and the page sent it again): not a conflict.
    if (t.summary_edited === cleaned.text) return json(200, { ok: true, version: Number(t.summary_version) || 0 });
    return json(409, { ok: false, conflict: true, version: Number(t.summary_version) || 0 });
  }
  return json(200, { ok: true, version: r.version });
}

/**
 * "Edit with AI": the model proposes new notes for the text now in the editor. Nothing is saved: the reply holds the proposed
 * text and its HTML with the changed lines marked, and the page asks the person to accept or discard it. Counts against the same
 * per-link question limits and the same daily Neuron cap as questions. Logs only what answerQuestion logs (model, Neurons, time).
 */
async function aiEdit(env, nowSec, t, form) {
  if (!questionsEnabled(env)) return json(503, { ok: false, error: MESSAGES.aiOff });
  const asked = cleanQuestion(form.get('ai'));
  if (!asked.ok) return json(400, { ok: false, error: String(form.get('ai') ?? '').trim() ? asked.reason : MESSAGES.aiEmpty });
  const notes = cleanSummaryEdit(form.get('summary'));
  if (!notes.ok) return json(400, { ok: false, error: notes.reason });
  if (qaUsesCloudflare(env) && (await neuronsToday(env.DB, nowSec)).total >= softCaps(env).qa) {
    return json(429, { ok: false, error: MESSAGES.paused }, { 'Retry-After': String(secondsUntilMidnightUtc(nowSec)) });
  }
  const slot = await takeQuestionSlot(env.DB, t.token_hash, nowSec, questionLimits(env));
  if (!slot.ok) return json(429, { ok: false, error: MESSAGES.busyLink }, { 'Retry-After': String(slot.retryAfterSec) });

  const pieces = await selectContext(env.DB, t.id, asked.question);
  const messages = buildEditMessages({ notes: notes.text, excerpts: joinContext(pieces), instruction: asked.question });
  // Whole notes can take a while to write: allow 30 s plus 15 ms per output token (Gemma wrote about 900 tokens in 13 s on
  // 2026-11-23), so a long answer is not cut off and retried elsewhere while the first model is still working and billing.
  const maxTokens = editOutputTokens(notes.text);
  const result = await answerQuestion(env, messages, nowSec, { maxTokens, maxChars: 40_000, timeoutMs: 30_000 + maxTokens * 15, groqReasoningEffort: 'low', groqReasoningTokens: 1500 });
  if (!result.ok) return json(result.reason === 'busy' ? 429 : 503, { ok: false, error: result.reason === 'busy' ? MESSAGES.modelBusy : MESSAGES.modelDown });

  const reply = parseEditReply(result.text);
  if (!reply) return json(502, { ok: false, error: MESSAGES.aiUnusable });
  // Fixed messages only (the rule at the top of this file): the model's own words, which a transcript could steer, are never
  // shown, so its reason for refusing and its search words stay out of the reply.
  if (reply.kind === 'error') return json(200, { ok: false, error: MESSAGES.aiRefused });
  let proposed;
  if (reply.kind === 'replacements') {
    const applied = applyReplacements(notes.text, reply.replacements);
    if (!applied.count) return json(200, { ok: false, error: MESSAGES.aiNotFound });
    proposed = applied.text;
  } else {
    proposed = reply.notes;
  }
  const checked = cleanSummaryEdit(proposed);
  if (!checked.ok) return json(502, { ok: false, error: MESSAGES.aiUnusable });
  const diff = changedLines(notes.text, checked.text);
  if (!diff.changed.size && !diff.removed) return json(200, { ok: false, error: MESSAGES.aiNoChange });
  return json(200, {
    ok: true,
    text: checked.text,
    html: renderNote(checked.text, { changed: diff.changed }),
    changed: diff.changed.size,
    removed: diff.removed, // lines removed without being replaced (changedLines pairs replaced lines off)
  });
}

async function handleQuestion(request, env, ctx, url, nowSec, t, enabled, view) {
  if (!isOwnPost(request.headers, url.origin)) return plain(403, 'Forbidden');
  if (!enabled) return page(view());
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('Content-Type') ?? '')) return plain(415, 'Unsupported Media Type');
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return plain(413, 'Payload Too Large');
  const body = await request.text();
  if (body.length > MAX_FORM_BYTES) return plain(413, 'Payload Too Large');

  const asked = cleanQuestion(new URLSearchParams(body).get('q'));
  if (!asked.ok) return page(view({ error: asked.reason }), 400);

  // The account-wide limit is the day's Cloudflare Neuron meter (the free allowance is shared with the summaries). Over the
  // Q&A cap, questions pause until the meter resets at 00:00 UTC. Checked before a question is counted against the link.
  if (qaUsesCloudflare(env) && (await neuronsToday(env.DB, nowSec)).total >= softCaps(env).qa) {
    return page(view({ question: asked.question, error: MESSAGES.paused }), 429, { 'Retry-After': String(secondsUntilMidnightUtc(nowSec)) });
  }

  const slot = await takeQuestionSlot(env.DB, t.token_hash, nowSec, questionLimits(env));
  if (!slot.ok) {
    return page(view({ question: asked.question, error: MESSAGES.busyLink }), 429, { 'Retry-After': String(slot.retryAfterSec) });
  }

  // Hybrid retrieval: keyword search always; meaning-based search too when this transcript is in the vector index.
  // A transcript that is not indexed yet is answered with keywords alone this time and indexed in the background.
  let semantic = [];
  if (t.embedded_at) semantic = await semanticHits(env, t.id, asked.question, nowSec);
  else if (ctx?.waitUntil) ctx.waitUntil(embedIfDue(env, t.id, nowSec));
  const pieces = await selectContext(env.DB, t.id, asked.question, { semantic });
  if (!pieces.length) return page(view({ question: asked.question, error: MESSAGES.nothing }), 404);
  const result = await answerQuestion(env, buildMessages({ summary: t.summary_edited || t.summary_text, actions: t.summary_edited ? null : t.actions_text, excerpts: joinContext(pieces), question: asked.question }), nowSec);
  if (!result.ok) {
    const busy = result.reason === 'busy';
    return page(view({ question: asked.question, error: busy ? MESSAGES.modelBusy : MESSAGES.modelDown }), busy ? 429 : 503, busy ? { 'Retry-After': '60' } : {});
  }
  return page(view({ question: asked.question, answer: result.text }));
}

export async function handleHttp(request, env, ctx, nowSec) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, env, url, nowSec, ctx);
  if (url.pathname === '/robots.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response('User-agent: *\nAllow: /privacy\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (url.pathname === '/privacy' && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response(request.method === 'HEAD' ? null : privacyPage({ contactEmail: env.PRIVACY_CONTACT_EMAIL }), { headers: PRIVACY_HEADERS });
  }
  if (url.pathname === GOOGLE_CALLBACK_PATH) return handleGoogleCallback(request, env, ctx, url, nowSec);
  if (url.pathname.startsWith('/t/')) return handleShare(request, env, ctx, url, nowSec);
  return null;
}
