// HTTP endpoints the GitHub recorder calls. Both need `Authorization: Bearer <WORKER_SHARED_SECRET>`.
//   GET  /api/sessions/<session id>/stop   -> { "stop": true | false }        (polled every 15 s while recording)
//   POST /api/transcripts                  -> stores a finished transcript    (called once, at the end)
// Nothing here ever logs transcript text, names or secrets.
import { bearerMatches } from './secure.js';
import { SESSION_ID_RE, getSession, readStopFlag, saveTranscript, transcriptIdExists } from './recording-store.js';
import { validateTranscriptPayload } from './transcript-payload.js';

const MAX_BODY_CHARS = 1_000_000; // about 1 MB, as in the spec
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const respond = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e?.message ?? ''));

export async function handleApi(request, env, url, nowSec) {
  const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
  const isTranscripts = url.pathname === '/api/transcripts';
  if (!stopMatch && !isTranscripts) return respond({ error: 'not found' }, 404);

  const method = stopMatch ? 'GET' : 'POST';
  if (request.method !== method) {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: method, 'Cache-Control': 'no-store' } });
  }
  if (!env.DB || !env.WORKER_SHARED_SECRET) {
    console.error('API is not configured: missing the DB binding or WORKER_SHARED_SECRET.');
    return respond({ error: 'server is not configured' }, 500);
  }
  if (!(await bearerMatches(request, env.WORKER_SHARED_SECRET))) return respond({ error: 'unauthorized' }, 401);

  try {
    if (stopMatch) return await stopFlag(env, stopMatch[1], nowSec);
    return await storeTranscript(request, env, nowSec);
  } catch (e) {
    // Never log the message: an exception message can contain anything, including request data. Only the
    // error type and, if present, a database error code such as SQLITE_CONSTRAINT or D1_ERROR.
    const code = /\b(D1_[A-Z_]+|SQLITE_[A-Z_]+)\b/.exec(String(e?.message ?? ''))?.[1] ?? '';
    console.error(`api error: ${String(e?.name ?? 'Error').slice(0, 40)} ${code}`.trim());
    return respond({ error: 'internal error' }, 500);
  }
}

async function stopFlag(env, rawId, nowSec) {
  // An unknown or malformed session answers "keep going": a stray id must never stop a real recording.
  if (!SESSION_ID_RE.test(rawId)) return respond({ stop: false });
  return respond({ stop: await readStopFlag(env.DB, rawId, nowSec) });
}

async function storeTranscript(request, env, nowSec) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 2) return respond({ error: 'body too large' }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return respond({ error: 'body too large' }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: 'body is not valid JSON' }, 400);
  }
  const checked = validateTranscriptPayload(body);
  if (!checked.ok) return respond({ error: 'invalid fields', fields: checked.bad }, 400);
  const t = checked.value;

  // The session, when there is one, must be for the same voice channel. Guards against a mix-up between teams.
  if (t.session_id) {
    const session = await getSession(env.DB, t.session_id);
    if (session && (session.voice_channel_id !== t.voice_channel_id || session.guild_id !== t.guild_id)) {
      return respond({ error: 'invalid fields', fields: ['session_id'] }, 400);
    }
  }
  if (await transcriptIdExists(env.DB, t.id)) return respond({ error: 'id already exists' }, 409);

  try {
    const { chunks } = await saveTranscript(env.DB, t, nowSec);
    return respond({ ok: true, id: t.id, chunks });
  } catch (e) {
    if (isUniqueViolation(e)) return respond({ error: 'id already exists' }, 409); // lost a race with another upload
    throw e;
  }
}
