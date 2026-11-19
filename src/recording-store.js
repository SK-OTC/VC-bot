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
