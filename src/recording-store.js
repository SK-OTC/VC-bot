// Database access for recording sessions and stored transcripts. Every query uses bound parameters.
import { chunkTranscript } from './chunk.js';

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
export const TRANSCRIPT_ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/; // the recorder's alphabet (no look-alikes)

const ROWS_PER_INSERT = 30; // 3 values per row = 90, under D1's limit of 100 bound values per statement

// ---------- sessions ----------

export async function getSession(db, id) {
  return (await db.prepare('SELECT * FROM recording_sessions WHERE id = ?').bind(id).first()) ?? null;
}

/**
 * The recorder asks "should I stop?" every 15 seconds. The first answer also tells us the job is alive,
 * so a session still marked 'starting' becomes 'running'. Only that first call writes; the rest only read.
 */
export async function readStopFlag(db, id, nowSec) {
  const row = await db.prepare('SELECT status, stop_flag FROM recording_sessions WHERE id = ?').bind(id).first();
  if (!row) return false;
  if (row.status === 'starting') {
    await db
      .prepare("UPDATE recording_sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'starting'")
      .bind(nowSec, id)
      .run();
  }
  return row.stop_flag === 1;
}

const LIVE = "('starting', 'running')";
export const STALE_STARTING_SEC = 20 * 60; // the job never reported in (queue + start-up is normally under a minute or two)
export const STALE_RUNNING_SEC = 6 * 3600; // longer than the workflow's own 5 hour limit, so the job is certainly gone

/**
 * A crashed or cancelled job would otherwise keep its channel "being recorded" for ever, because the database allows
 * one live session per voice channel. Marks sessions that are too old to still be alive as failed.
 */
export async function failStaleSessions(db, guildId, nowSec) {
  await db
    .prepare(
      `UPDATE recording_sessions SET status = 'failed', error = 'the recorder never finished', updated_at = ?
       WHERE guild_id = ? AND ((status = 'starting' AND created_at < ?) OR (status = 'running' AND created_at < ?))`,
    )
    .bind(nowSec, guildId, nowSec - STALE_STARTING_SEC, nowSec - STALE_RUNNING_SEC)
    .run();
}

/** Live (starting or running) sessions in a server, optionally for one voice channel. */
export async function findLiveSessions(db, guildId, channelId = null) {
  const sql = `SELECT * FROM recording_sessions WHERE guild_id = ? AND status IN ${LIVE}${channelId ? ' AND voice_channel_id = ?' : ''} ORDER BY created_at`;
  const stmt = db.prepare(sql).bind(...(channelId ? [guildId, channelId] : [guildId]));
  return (await stmt.all()).results;
}

/** Creates a session. { ok: false, conflict: true } when that voice channel already has a live one. */
export async function createSession(db, { id, channelId, guildId, startedBy, meetingId = null }, nowSec) {
  try {
    await db
      .prepare(
        'INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, meeting_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, channelId, guildId, startedBy, meetingId, 'starting', nowSec, nowSec)
      .run();
    return { ok: true };
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String(e?.message ?? ''))) return { ok: false, conflict: true };
    throw e;
  }
}

/** Asks the recorder to stop. It sees the flag on its next 15 second check. */
export async function requestStop(db, id, nowSec) {
  await db.prepare(`UPDATE recording_sessions SET stop_flag = 1, updated_at = ? WHERE id = ? AND status IN ${LIVE}`).bind(nowSec, id).run();
}

/** Ends a live session ('done' or 'failed'). Sessions that already ended are left alone. */
export async function endSession(db, id, status, error, nowSec) {
  const message = error ? String(error).slice(0, 300) : null;
  await db
    .prepare(`UPDATE recording_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ${LIVE}`)
    .bind(status, message, nowSec, id)
    .run();
}

// ---------- recording setups (/setup-recording) ----------

export const MAX_SETUPS_PER_GUILD = 25;

/** The setup for a voice channel, or null. Pass guildId to require that it belongs to that server. */
export async function getRecordingSetup(db, voiceChannelId, guildId = null) {
  const row = await db.prepare('SELECT * FROM recording_setups WHERE voice_channel_id = ?').bind(voiceChannelId).first();
  if (!row || (guildId && row.guild_id !== guildId)) return null;
  return row;
}

export async function listRecordingSetups(db, guildId) {
  return (await db.prepare('SELECT * FROM recording_setups WHERE guild_id = ? ORDER BY name COLLATE NOCASE, voice_channel_id').bind(guildId).all()).results;
}

export async function countRecordingSetups(db, guildId) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM recording_setups WHERE guild_id = ?').bind(guildId).first())?.n ?? 0;
}

/**
 * Creates or replaces the setup for a voice channel. A voice channel belongs to one server, so an existing row is only
 * ever replaced by the same server: { ok: false } when another server already holds that channel id.
 */
export async function saveRecordingSetup(db, s, nowSec) {
  const existing = await db.prepare('SELECT guild_id, created_by, created_at FROM recording_setups WHERE voice_channel_id = ?').bind(s.voiceChannelId).first();
  if (existing && existing.guild_id !== s.guildId) return { ok: false };
  await db
    .prepare(
      `INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, backup_channel_id, glossary, language, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (voice_channel_id) DO UPDATE SET name = excluded.name, transcript_channel_id = excluded.transcript_channel_id,
         backup_channel_id = excluded.backup_channel_id, glossary = excluded.glossary, language = excluded.language, updated_at = excluded.updated_at`,
    )
    .bind(s.voiceChannelId, s.guildId, s.name, s.transcriptChannelId, s.backupChannelId ?? null, s.glossary ?? '', s.language ?? 'en', s.createdBy, existing?.created_at ?? nowSec, nowSec)
    .run();
  return { ok: true, updated: Boolean(existing) };
}

export async function deleteRecordingSetup(db, voiceChannelId, guildId) {
  const r = await db.prepare('DELETE FROM recording_setups WHERE voice_channel_id = ? AND guild_id = ?').bind(voiceChannelId, guildId).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function transcriptIdExists(db, id) {
  return (await db.prepare('SELECT 1 AS x FROM transcripts WHERE id = ?').bind(id).first()) !== null;
}

// ---------- transcripts ----------

/**
 * Stores one transcript, its chunks and (if the session is known) marks the session done, all in one
 * transaction: either everything is saved or nothing is. `t` is the validated payload.
 * Throws if the id already exists (a UNIQUE violation); the caller turns that into a 409.
 */
export async function saveTranscript(db, t, nowSec) {
  const chunks = chunkTranscript(t.transcript_text);
  const statements = [
    db
      .prepare(
        `INSERT INTO transcripts
           (id, session_id, guild_id, voice_channel_id, post_channel_id, transcript_message_id, summary_message_id,
            started_at, duration_sec, speakers, engine, language, summary_text, actions_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        t.id,
        t.session_id,
        t.guild_id,
        t.voice_channel_id,
        t.post_channel_id,
        t.transcript_message_id,
        t.summary_message_id,
        t.started_at,
        t.duration_sec,
        JSON.stringify(t.speakers),
        t.engine,
        t.language,
        t.summary_text,
        t.actions_text,
        nowSec,
      ),
  ];
  for (let i = 0; i < chunks.length; i += ROWS_PER_INSERT) {
    const slice = chunks.slice(i, i + ROWS_PER_INSERT);
    const values = slice.map(() => '(?, ?, ?)').join(', ');
    const params = slice.flatMap((text, j) => [t.id, i + j, text]);
    statements.push(db.prepare(`INSERT INTO transcript_chunks (transcript_id, seq, text) VALUES ${values}`).bind(...params));
  }
  if (t.session_id) {
    statements.push(
      db
        .prepare("UPDATE recording_sessions SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('starting', 'running')")
        .bind(nowSec, t.session_id),
    );
  }
  await db.batch(statements);
  return { chunks: chunks.length };
}
