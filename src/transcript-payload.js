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
  for (const f of ['guild_id', 'voice_channel_id', 'post_channel_id', 'transcript_message_id']) check(f, typeof body[f] === 'string' && ID_RE.test(body[f]));
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

  if (bad.length) return { ok: false, bad };
  return {
    ok: true,
    value: {
      id: body.id,
      session_id: body.session_id || null,
      guild_id: body.guild_id,
      voice_channel_id: body.voice_channel_id,
      post_channel_id: body.post_channel_id,
      transcript_message_id: body.transcript_message_id,
      summary_message_id: body.summary_message_id || null,
      started_at: Math.floor(startedMs / 1000),
      duration_sec: body.duration_sec,
      speakers: body.speakers.map((s) => ({ name: s.name, speaking_sec: s.speaking_sec })),
      engine: body.engine,
      language: body.language,
      transcript_text: body.transcript_text,
      summary_text: body.summary_text || null,
      actions_text: body.actions_text || null,
    },
  };
}
