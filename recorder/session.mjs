// Everything the recorder does after the recording ends: transcribe, summarise, post, store, clean up.
// Takes plain functions for Discord actions so it can be tested without Discord.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from '../pipeline/run.mjs';
import { displayNames, buildHeader, formatTranscript, hhmmss } from '../pipeline/transcript.mjs';
import { summarize, splitMessage } from '../pipeline/summary.mjs';
import { uploadTranscript, shortId } from '../pipeline/upload.mjs';
import { batchAttachments } from './stop.mjs';

/**
 * speakers: [{ label, name, files }]     (name may be null)
 * io: { postTranscript({content, file:{name, data}}) -> {messageId}, postText(text) -> {messageId}, postBackup(content, files) }
 * Returns { ok, id, notes[] } and never throws for a model, storage or backup problem: a transcript that exists must be delivered.
 */
export async function finishSession({ speakers, offsetSec, startedAt, cfg, engine, fallbackEngine, chat, io, log = () => {}, sessionId = '', voiceChannelId, guildId }) {
  const notes = [];
  const work = mkdtempSync(path.join(tmpdir(), 'rec-'));
  try {
    const names = displayNames(speakers.map((s) => ({ label: s.label, name: s.name })));
    const { lines, failures, stats } = await runPipeline({
      speakers: speakers.map((s) => ({ label: s.label, files: s.files })),
      engine,
      fallbackEngine,
      workDir: work,
      glossary: cfg.team.glossary,
      log,
    });
    const lengthSec = Math.max(0, stats.lengthSec - offsetSec);
    const header = buildHeader({ startedAt, lengthSec, speakers: stats.speakers, names, engines: stats.engines, fallbackBatches: stats.fallbackBatches, failedBatches: stats.failedBatches });
    const text = formatTranscript({ lines, failures, names, offsetSec, header });
    const body = text.slice(header.length);
    const id = shortId();

    if (stats.transcribedBatches === 0 && stats.batches > 0) notes.push('Nothing could be transcribed.');

    // 1. The transcript file, with a short heading.
    const when = new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ');
    const heading = `**${cfg.team.name} meeting transcript** · ${when} UTC · ${hhmmss(lengthSec)} · ID \`${id}\``;
    const posted = await io.postTranscript({ content: heading, file: { name: `transcript-${id}.txt`, data: Buffer.from(text, 'utf8') } });

    // 2. Summary and action items, posted under the transcript.
    let summary = { ok: false, reason: 'no language model is configured' };
    if (chat && body.trim()) summary = await summarize({ transcriptBody: body, chat, log });
    let summaryMessageId = null;
    if (summary.ok) {
      const parts = splitMessage(summary.text, 1900);
      for (const p of parts) summaryMessageId = (await io.postText(p, { replyTo: posted.messageId })).messageId ?? summaryMessageId;
    } else if (body.trim()) {
      await io.postText(`Summary unavailable (${summary.reason}). The transcript above is complete.`, { replyTo: posted.messageId });
      notes.push(`summary failed: ${summary.reason}`);
    }

    // 3. Audio backup (pilot). Only when a backup channel is configured; otherwise audio is simply deleted with the work folder.
    if (cfg.team.backupChannelId) {
      try {
        const files = speakers.flatMap((s) => s.files).map((f) => ({ path: f, name: path.basename(f), size: statSync(f).size }));
        const { batches, tooBig } = batchAttachments(files);
        for (let i = 0; i < batches.length; i++) {
          await io.postBackup(i === 0 ? `Audio backup for transcript \`${id}\` (${cfg.team.name}). Speaker numbers match the transcript order.` : `(more audio, part ${i + 1} of ${batches.length})`, batches[i]);
        }
        if (tooBig.length) await io.postBackup(`Not attached (over the upload limit): ${tooBig.map((f) => f.name).join(', ')}.`, []);
      } catch (e) {
        notes.push(`audio backup failed: ${String(e.message).slice(0, 100)}`);
        log(`audio backup failed: ${e.message}`);
      }
    }

    // 4. Store for /transcript. A failure here is reported, not fatal.
    let stored = { ok: false, reason: 'storage is not configured' };
    if (cfg.workerUrl && cfg.workerSecret) {
      stored = await uploadTranscript({
        url: `${cfg.workerUrl}/api/transcripts`,
        secret: cfg.workerSecret,
        payload: {
          id,
          session_id: sessionId || null,
          guild_id: guildId,
          voice_channel_id: voiceChannelId,
          post_channel_id: cfg.team.transcriptChannelId,
          transcript_message_id: posted.messageId,
          summary_message_id: summaryMessageId,
          started_at: new Date(startedAt).toISOString(),
          duration_sec: Math.round(lengthSec),
          speakers: stats.speakers.map((s) => ({ name: names[s.label], speaking_sec: Math.round(s.speechSec) })),
          engine: [...stats.engines].join(', '),
          language: cfg.team.language,
          transcript_text: text,
          summary_text: summary.ok ? summary.text : null,
          actions_text: summary.ok ? summary.actions : null,
        },
      });
      if (!stored.ok) {
        notes.push(`not saved for /transcript: ${stored.reason}`);
        await io.postText(`This transcript could not be saved for \`/transcript\` search (${stored.reason}). The file above is the only copy.`, { replyTo: posted.messageId }).catch(() => {});
      } else if (stored.shareUrl) {
        // The private web link goes only to the team's private channel. <...> stops Discord making a preview card.
        const until = stored.shareExpiresAt ? ` until <t:${stored.shareExpiresAt}:D>` : '';
        try {
          await io.postText(
            `🔗 **Summary and Q&A online:** <${stored.shareUrl}>\nAnyone who has this link can read the summary and ask questions about the meeting${until}. Turn it off any time with \`/unshare-transcript\`.`,
            { replyTo: posted.messageId },
          );
        } catch {
          notes.push('could not post the web link'); // never include the link itself in notes or logs
        }
      }
    } else {
      notes.push('storage not configured (WORKER_URL / WORKER_SHARED_SECRET)');
    }

    return { ok: true, id, notes, stats: { speakers: stats.speakers.length, batches: stats.batches, failed: stats.failedBatches, fallback: stats.fallbackBatches, dropped: stats.droppedSegments }, stored: stored.ok, summarised: summary.ok };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
