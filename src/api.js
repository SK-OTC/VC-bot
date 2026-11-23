// HTTP endpoints the GitHub recorder calls. All need `Authorization: Bearer <WORKER_SHARED_SECRET>`.
//   GET  /api/sessions/<session id>/stop    -> { "stop": true | false }        (polled every 15 s while recording)
//   GET  /api/ai-budget                     -> { summary_allowed, neurons_today, summary_cap }  (the recorder asks before choosing a model)
//   GET  /api/sessions/<session id>/config  -> where that session's results go (404 if no /setup-recording; 409 once it has ended)
//   POST /api/sessions/<session id>/finish  -> { "ok": true }                  (the job ended: { status: "done" | "failed", error? })
//   POST /api/transcripts                   -> stores a finished transcript    (called once, at the end); the answer
//                                              includes a one-time private web link: { ok, id, chunks, share_url?, share_expires_at? }
// Nothing here ever logs transcript text, names or secrets.
import { bearerMatches } from './secure.js';
import { SESSION_ID_RE, endSession, getRecordingSetup, getSession, getTranscriptSettings, readStopFlag, resolveRouting, saveTranscript, transcriptIdExists } from './recording-store.js';
import { validateTranscriptPayload } from './transcript-payload.js';
import { configuredDays, createShareLink, linkUrl, publicOrigin } from './share-store.js';
import { embedIfDue } from './semantic.js';
import { addNeurons, neuronsToday, softCaps } from './meter.js';

const MAX_BODY_CHARS = 1_000_000; // about 1 MB, as in the spec
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const respond = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e?.message ?? ''));

export async function handleApi(request, env, url, nowSec, ctx = null) {
  const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
  const finishMatch = /^\/api\/sessions\/([^/]+)\/finish$/.exec(url.pathname);
  const configMatch = /^\/api\/sessions\/([^/]+)\/config$/.exec(url.pathname);
  const isTranscripts = url.pathname === '/api/transcripts';
  const isBudget = url.pathname === '/api/ai-budget';
  if (!stopMatch && !finishMatch && !configMatch && !isTranscripts && !isBudget) return respond({ error: 'not found' }, 404);

  const method = stopMatch || configMatch || isBudget ? 'GET' : 'POST';
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
    if (finishMatch) return await finishFromRecorder(request, env, finishMatch[1], nowSec);
    if (configMatch) return await sessionConfig(env, configMatch[1]);
    if (isBudget) return await aiBudget(env, nowSec);
    return await storeTranscript(request, env, url, nowSec, ctx);
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

/**
 * Does today's Cloudflare Neuron budget have room for a summary? The recorder asks before choosing a model, because only the
 * Worker can see the account-wide meter. Numbers only.
 */
async function aiBudget(env, nowSec) {
  const today = await neuronsToday(env.DB, nowSec);
  const cap = softCaps(env).summary;
  return respond({ day: today.day, neurons_today: Math.round(today.total * 100) / 100, summary_cap: cap, summary_allowed: today.total < cap });
}

/**
 * Where this recording's transcript goes, from /setup-recording. Only the session's own voice channel is ever returned,
 * and only to a caller with the shared secret, so the channel mapping never has to appear in GitHub's public logs.
 */
async function sessionConfig(env, rawId) {
  if (!SESSION_ID_RE.test(rawId)) return respond({ error: 'not found' }, 404);
  const session = await getSession(env.DB, rawId);
  if (!session) return respond({ error: 'not found' }, 404);
  // A session that already ended (a GitHub job re-run by hand, or a second copy of the job) must not record and post again.
  if (session.status !== 'starting' && session.status !== 'running') return respond({ error: 'session ended' }, 409);
  const setup = await getRecordingSetup(env.DB, session.voice_channel_id, session.guild_id);
  if (!setup) return respond({ error: 'not found' }, 404);
  // What to do with the results: the server's /transcript-settings (save, post, destination), then the session's named recording
  // setup (fixed when it started), falling back to the voice channel's own transcript channel and then the channel where the
  // recording was started (see resolveRouting).
  const route = resolveRouting({ settings: await getTranscriptSettings(env.DB, session.guild_id), setup, session });
  // The backup channel is where a transcript file that could not be posted is rescued to, so the recorder refuses one that is the
  // transcript channel itself. A named setup's private channel can be that same channel: then there is no separate backup, and the
  // audio (which would have gone to the backup channel) is sent as the setup's audio, to that same private channel.
  const backupOut = route.backupChannelId && route.backupChannelId !== route.privateChannelId ? route.backupChannelId : null;
  const audioOut = route.audioChannelId && route.audioChannelId !== backupOut ? route.audioChannelId : null;
  return respond({
    voice_channel_id: setup.voice_channel_id,
    guild_id: setup.guild_id,
    name: setup.name,
    transcript_channel_id: route.privateChannelId, // the private channel; null when posting is off (or there is nowhere to post)
    save: route.save,
    post: route.post,
    // Who gets the summary link in a private message when posting is off: the person who started it (not for scheduled starts).
    dm_user_id: /^\d{17,20}$/.test(String(session.started_by)) ? String(session.started_by) : null,
    backup_channel_id: backupOut,
    glossary: setup.glossary,
    language: setup.language,
    // Named recording setups (/recording setup). Each is null when unused: the summary then goes with the transcript, no
    // "recording ready" link is posted, and the audio goes to the backup channel (if any).
    summary_channel_id: route.summaryChannelId !== route.privateChannelId ? route.summaryChannelId : null,
    link_channel_id: route.linkChannelId,
    audio_channel_id: audioOut,
    setup_name: route.setupName,
  });
}

/**
 * The recorder calls this when its job ends for any reason (no speech, crash, cancelled), so the voice channel is
 * free for the next /start-recording. An unknown or already-ended session is accepted and ignored.
 */
async function finishFromRecorder(request, env, rawId, nowSec) {
  if (!SESSION_ID_RE.test(rawId)) return respond({ ok: true });
  const text = await request.text();
  if (text.length > 10_000) return respond({ error: 'body too large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: 'body is not valid JSON' }, 400);
  }
  if (!body || (body.status !== 'done' && body.status !== 'failed')) return respond({ error: 'invalid fields', fields: ['status'] }, 400);
  await endSession(env.DB, rawId, body.status, typeof body.error === 'string' ? body.error : null, nowSec);
  return respond({ ok: true });
}

async function storeTranscript(request, env, url, nowSec, ctx) {
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
    // Every stored transcript gets a private web link, returned once (only its hash is kept) so the recorder can post
    // it in the team's private channel. SHARE_LINK_DAYS=0 turns this off. A failure here never loses the transcript.
    const out = { ok: true, id: t.id, chunks };
    // The summary's cost goes on the daily Neuron meter (the recorder spent it on Cloudflare, even if a fallback model finished the job).
    if (t.ai_usage?.neurons > 0) {
      try {
        await addNeurons(env.DB, 'summary', t.ai_usage.neurons, nowSec);
      } catch {
        // the transcript is saved; a missed meter update only means the meter under-counts a little
      }
    }
    // Long transcripts are indexed for meaning-based search after the answer is sent, so the recorder is not kept waiting.
    // If that fails, the first question about the meeting tries again (see src/semantic.js).
    if (ctx?.waitUntil) ctx.waitUntil(embedIfDue(env, t.id, nowSec));
    const days = configuredDays(env);
    if (days > 0) {
      try {
        const link = await createShareLink(env.DB, { transcriptId: t.id, createdBy: 'recorder', days }, nowSec);
        if (link.ok) {
          out.share_url = linkUrl(publicOrigin(env, url.origin), link.token);
          out.share_expires_at = link.expiresAt;
        }
      } catch {
        // the transcript is saved; /share-transcript can make a link later
      }
    }
    return respond(out);
  } catch (e) {
    if (isUniqueViolation(e)) return respond({ error: 'id already exists' }, 409); // lost a race with another upload
    throw e;
  }
}
