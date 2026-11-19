// Plain HTTP routes that are not Discord interactions. Returns a Response, or null to let index.js carry on
// with its normal handling (the health check and the signed Discord interactions).
//   /api/...        recorder endpoints (own secret)
//   /t/<token>      a private meeting page: summary plus "ask a question" (the token in the address is the only key)
//   /robots.txt     tells well-behaved crawlers to stay away from everything
import { handleApi } from './api.js';
import { MAX_QUESTION_CHARS, askGroq, buildMessages, cleanQuestion, joinContext, questionLimits, questionsEnabled, selectContext, takeQuestionSlot } from './ask.js';
import { embedIfDue, semanticHits } from './semantic.js';
import { SECURITY_HEADERS, notFoundPage, transcriptPage } from './share-page.js';
import { TOKEN_RE, findSharedTranscript, recordView } from './share-store.js';

const MAX_FORM_BYTES = 8192;
const page = (html, status = 200, extra = {}) => new Response(html, { status, headers: { ...SECURITY_HEADERS, ...extra } });
const plain = (status, text) => new Response(text, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

// Fixed messages only: nothing from the model, the database or the request is ever put in an error line.
const MESSAGES = {
  empty: 'Type a question first.',
  busyTotal: 'Questions are paused for today because the daily limit has been reached. Please try again tomorrow.',
  busyLink: "You've asked a lot of questions in a short time. Please wait a little and try again.",
  nothing: "I don't have any transcript text for this meeting, so I can't answer questions about it.",
  modelBusy: 'The assistant is busy right now. Please try again in a minute.',
  modelDown: "I couldn't get an answer just now. Please try again in a moment.",
};

async function handleShare(request, env, ctx, url, nowSec) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST' } });
  }
  const token = url.pathname.slice('/t/'.length);
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

async function handleQuestion(request, env, ctx, url, nowSec, t, enabled, view) {
  // Cross-site posts are refused: a page on another site must not be able to make a reader's browser ask questions.
  const origin = request.headers.get('Origin');
  if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return plain(403, 'Forbidden');
  if (!enabled) return page(view());
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('Content-Type') ?? '')) return plain(415, 'Unsupported Media Type');
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return plain(413, 'Payload Too Large');
  const body = await request.text();
  if (body.length > MAX_FORM_BYTES) return plain(413, 'Payload Too Large');

  const asked = cleanQuestion(new URLSearchParams(body).get('q'));
  if (!asked.ok) return page(view({ error: asked.reason }), 400);

  const slot = await takeQuestionSlot(env.DB, t.token_hash, nowSec, questionLimits(env));
  if (!slot.ok) {
    return page(view({ question: asked.question, error: slot.scope === 'total' ? MESSAGES.busyTotal : MESSAGES.busyLink }), 429, { 'Retry-After': String(slot.retryAfterSec) });
  }

  // Hybrid retrieval: keyword search always; meaning-based search too when this transcript is in the vector index.
  // A transcript that is not indexed yet is answered with keywords alone this time and indexed in the background.
  let semantic = [];
  if (t.embedded_at) semantic = await semanticHits(env, t.id, asked.question);
  else if (ctx?.waitUntil) ctx.waitUntil(embedIfDue(env, t.id, nowSec));
  const pieces = await selectContext(env.DB, t.id, asked.question, { semantic });
  if (!pieces.length) return page(view({ question: asked.question, error: MESSAGES.nothing }), 404);
  const result = await askGroq(env, buildMessages({ summary: t.summary_text, actions: t.actions_text, excerpts: joinContext(pieces), question: asked.question }));
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
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (url.pathname.startsWith('/t/')) return handleShare(request, env, ctx, url, nowSec);
  return null;
}
