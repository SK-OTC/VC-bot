// Checking what the recorder sends to POST /api/transcripts. The shape is exactly what recorder/session.mjs
// builds. The result never contains transcript text in its error list: only field names.
import { SESSION_ID_RE, TRANSCRIPT_ID_RE } from './recording-store.js';

const ID_RE = /^\d{17,20}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const MAX_TRANSCRIPT_CHARS = 900_000;
const MAX_SUMMARY_CHARS = 30_000;
const DAY_SEC = 86_400;

const isStr = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateTranscriptPayload(body) {
  const bad = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, bad: ['body'] };

  const check = (field, ok) => {
    if (!ok) bad.push(field);
  };
  const nullableStr = (v, max) => v === null || v === undefined || isStr(v, max);

  check('id', typeof body.id === 'string' && TRANSCRIPT_ID_RE.test(body.id));
  check('session_id', body.session_id === null || body.session_id === undefined || (typeof body.session_id === 'string' && SESSION_ID_RE.test(body.session_id)));
  // post_channel_id is the channel the transcript was posted to, or the voice channel's own id when posting was off.
  // transcript_message_id is absent (or empty) when nothing was posted.
  for (const f of ['guild_id', 'voice_channel_id', 'post_channel_id']) check(f, typeof body[f] === 'string' && ID_RE.test(body[f]));
  check('transcript_message_id', body.transcript_message_id === null || body.transcript_message_id === undefined || body.transcript_message_id === '' || (typeof body.transcript_message_id === 'string' && ID_RE.test(body.transcript_message_id)));
  check('summary_message_id', body.summary_message_id === null || body.summary_message_id === undefined || (typeof body.summary_message_id === 'string' && ID_RE.test(body.summary_message_id)));

  const startedMs = typeof body.started_at === 'string' ? Date.parse(body.started_at) : NaN;
  check('started_at', Number.isFinite(startedMs) && startedMs > Date.UTC(2020, 0, 1) && startedMs < Date.UTC(2100, 0, 1));
  check('duration_sec', isInt(body.duration_sec, 0, DAY_SEC));

  const speakersOk =
    Array.isArray(body.speakers) &&
    body.speakers.length <= 100 &&
    body.speakers.every((s) => s && typeof s === 'object' && isStr(s.name, 100, 1) && isInt(s.speaking_sec, 0, DAY_SEC));
  check('speakers', speakersOk);

  check('engine', isStr(body.engine, 300));
  check('language', typeof body.language === 'string' && LANG_RE.test(body.language));
  check('transcript_text', isStr(body.transcript_text, MAX_TRANSCRIPT_CHARS, 1));
  check('summary_text', nullableStr(body.summary_text, MAX_SUMMARY_CHARS));
  check('actions_text', nullableStr(body.actions_text, MAX_SUMMARY_CHARS));

  // Optional: the glossary corrections made to the text (kept in the stored record only).
  let fixes = null;
  if (body.glossary_fixes !== undefined && body.glossary_fixes !== null) {
    const f = body.glossary_fixes;
    const ok =
      Array.isArray(f) &&
      f.length <= 500 &&
      f.every((x) => x && typeof x === 'object' && isStr(x.from, 80, 1) && isStr(x.to, 80, 1) && typeof x.t === 'number' && Number.isFinite(x.t) && x.t >= 0 && x.t <= DAY_SEC && ['listed', 'fuzzy', 'case'].includes(x.kind));
    check('glossary_fixes', ok);
    if (ok) fixes = f.map((x) => ({ from: x.from, to: x.to, t: x.t, kind: x.kind }));
  }

  // Optional: what writing the summary cost, so the Worker's daily Neuron meter can count it.
  let aiUsage = null;
  if (body.ai_usage !== undefined && body.ai_usage !== null) {
    const u = body.ai_usage;
    const ok =
      typeof u === 'object' &&
      !Array.isArray(u) &&
      (u.provider === null || u.provider === undefined || isStr(u.provider, 60)) &&
      typeof u.neurons === 'number' && Number.isFinite(u.neurons) && u.neurons >= 0 && u.neurons <= 200_000 &&
      (u.prompt_tokens === undefined || isInt(u.prompt_tokens, 0, 10_000_000)) &&
      (u.completion_tokens === undefined || isInt(u.completion_tokens, 0, 10_000_000)) &&
      (u.requests === undefined || isInt(u.requests, 0, 100_000)) &&
      (u.fell_back === undefined || typeof u.fell_back === 'boolean');
    check('ai_usage', ok);
    if (ok) aiUsage = { provider: u.provider ?? null, neurons: u.neurons, fell_back: Boolean(u.fell_back) };
  }

  if (bad.length) return { ok: false, bad };
  return {
    ok: true,
    value: {
      id: body.id,
      session_id: body.session_id || null,
      guild_id: body.guild_id,
      voice_channel_id: body.voice_channel_id,
      post_channel_id: body.post_channel_id,
      transcript_message_id: body.transcript_message_id || null,
      summary_message_id: body.summary_message_id || null,
      started_at: Math.floor(startedMs / 1000),
      duration_sec: body.duration_sec,
      speakers: body.speakers.map((s) => ({ name: s.name, speaking_sec: s.speaking_sec })),
      engine: body.engine,
      language: body.language,
      transcript_text: body.transcript_text,
      summary_text: body.summary_text || null,
      actions_text: body.actions_text || null,
      ai_usage: aiUsage,
      glossary_fixes: fixes,
    },
  };
}
