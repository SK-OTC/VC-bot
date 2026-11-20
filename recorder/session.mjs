// Everything the recorder does after the recording ends: transcribe, summarise, post, store, clean up.
// Takes plain functions for Discord actions so it can be tested without Discord.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from '../pipeline/run.mjs';
import { displayNames, buildHeader, formatTranscript, hhmmss } from '../pipeline/transcript.mjs';
import { runSummaryChain, splitMessage } from '../pipeline/summary.mjs';
import { composeSummaryMessage } from '../pipeline/summary-message.mjs';
import { uploadTranscript, shortId } from '../pipeline/upload.mjs';
import { batchAttachments } from './stop.mjs';

/**
 * speakers: [{ label, name, files }]     (name may be null)
 * io: { postTranscript({content, file:{name, data}}) -> {messageId}, postText(text, {replyTo}) -> {messageId},
 *       dm(text, {file}) -> {messageId} (a private message to whoever started the recording), postBackup(content, files) }
 * Returns { ok, id, notes[] } and never throws for a model, storage or backup problem: a transcript that exists must be delivered.
 */
export async function finishSession({ speakers, offsetSec, startedAt, cfg, engine, fallbackEngine, budgetSec = null, chat, providers = null, io, log = () => {}, sessionId = '', voiceChannelId, guildId }) {
  const notes = [];
  const work = mkdtempSync(path.join(tmpdir(), 'rec-'));
  try {
    const names = displayNames(speakers.map((s) => ({ label: s.label, name: s.name })));
    const { lines, failures, stats } = await runPipeline({
      budgetSec,
      speakers: speakers.map((s) => ({ label: s.label, files: s.files })),
      engine,
      fallbackEngine,
      workDir: work,
      glossary: cfg.team.glossary,
      log,
    });
    const lengthSec = Math.max(0, stats.lengthSec - offsetSec);
    const header = buildHeader({ startedAt, lengthSec, speakers: stats.speakers, names, engines: stats.engines, labels: stats.labels, primaryName: stats.primaryName, fallbackName: stats.fallbackName, fallbackBatches: stats.fallbackBatches, failedBatches: stats.failedBatches });
    const text = formatTranscript({ lines, failures, names, offsetSec, header });
    const body = text.slice(header.length);
    const id = shortId();

    if (stats.transcribedBatches === 0 && stats.batches > 0) notes.push('Nothing could be transcribed.');

    // What the server chose with /transcript-settings: SAVE (database + private web page) and POST (a channel). Both default on.
    // Saving and posting both off is refused when the settings are read, so at least one of them is on here.
    const post = cfg.team.post !== false;
    const wantSave = cfg.team.save !== false;
    const dmUserId = cfg.team.dmUserId || '';

    // 1. The transcript file, with a short heading (only when posting is on).
    const when = new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ');
    const heading = `**${cfg.team.name} meeting transcript** · ${when} UTC · ${hhmmss(lengthSec)} · ID \`${id}\``;
    const transcriptFile = { name: `transcript-${id}.txt`, data: Buffer.from(text, 'utf8') };
    const posted = post ? await io.postTranscript({ content: heading, file: transcriptFile }) : { messageId: null };

    // 2. Summary and action items. Models are tried in order (Cloudflare Llama, then Groq).
    const chain = providers ?? (chat ? [{ name: chat.name ?? 'groq-gpt-oss', label: chat.label ?? 'the language model', chat }] : []);
    let summary = { ok: false, reason: 'no language model is configured', usage: { neurons: 0, promptTokens: 0, completionTokens: 0, requests: 0 } };
    if (chain.length && body.trim()) summary = await runSummaryChain({ transcriptBody: body, glossary: cfg.team.glossary, providers: chain, log });
    if (summary.ok) log(`summary: written by ${summary.provider}${summary.fellBack ? ' after a fallback' : ''}; ${summary.flagged} of ${summary.checked} items unverified`);
    if (!summary.ok && body.trim()) notes.push(`summary failed: ${summary.reason}`);

    // 3. Save for the private web page, questions and editing. The summary is delivered AFTER this, because the link to the
    // full summary is made by the Worker when it saves the transcript. A failure here is reported, not fatal.
    let stored = { ok: false, reason: wantSave ? 'storage is not configured' : 'saving is turned off' };
    if (wantSave && cfg.workerUrl && cfg.workerSecret) {
      stored = await uploadTranscript({
        url: `${cfg.workerUrl}/api/transcripts`,
        secret: cfg.workerSecret,
        payload: {
          id,
          session_id: sessionId || null,
          guild_id: guildId,
          voice_channel_id: voiceChannelId,
          // The channel the transcript was posted to; with posting off, the voice channel's own id (a real channel, nothing posted).
          post_channel_id: post ? cfg.team.transcriptChannelId : voiceChannelId,
          transcript_message_id: posted.messageId,
          summary_message_id: null, // the summary message is sent after the save, so its id is not known yet (nothing reads it)
          started_at: new Date(startedAt).toISOString(),
          duration_sec: Math.round(lengthSec),
          speakers: stats.speakers.map((s) => ({ name: names[s.label], speaking_sec: Math.round(s.speechSec) })),
          engine: [...stats.engines].map((n) => stats.labels[n] ?? n).join(', '),
          // Every glossary correction (original, replacement, time): kept in the stored record only, never posted or logged.
          glossary_fixes: stats.glossaryFixes.slice(0, 500).map((f) => ({ from: f.from.slice(0, 80), to: f.to.slice(0, 80), t: Math.max(0, Math.round((f.t - offsetSec) * 10) / 10), kind: f.kind })),
          language: cfg.team.language,
          transcript_text: text,
          summary_text: summary.ok ? summary.text : null,
          actions_text: summary.ok ? summary.actions : null,
          // What the summary cost, so the Worker's daily Neuron meter counts it (also when a fallback model finished the job).
          ...(chain.length
            ? {
                ai_usage: {
                  provider: summary.ok ? summary.provider : null,
                  neurons: Math.round((summary.usage?.neurons ?? 0) * 10_000) / 10_000,
                  prompt_tokens: summary.usage?.promptTokens ?? 0,
                  completion_tokens: summary.usage?.completionTokens ?? 0,
                  requests: summary.usage?.requests ?? 0,
                  fell_back: Boolean(summary.fellBack),
                },
              }
            : {}),
        },
      });
      if (!stored.ok) notes.push(`not saved: ${stored.reason}`);
    } else if (wantSave) {
      notes.push('storage not configured (WORKER_URL / WORKER_SHARED_SECRET)');
    }

    // 4. Deliver the summary: in the channel (post on) or in a private message to whoever started the recording (post off).
    // With a link: ONE message with the summary (shortened only if it does not fit Discord's limit) and the link, which is always
    // complete. Without a link (saving off, or the save failed): the whole summary, over as many messages as it needs.
    const send = post
      ? (content) => io.postText(content, { replyTo: posted.messageId })
      : dmUserId
        ? (content) => io.dm(content)
        : null;
    if (!send) notes.push('nothing was delivered: posting is off and nobody started this recording (a scheduled one), so there is nobody to send the link to');
    else {
      try {
        const linked = stored.ok && stored.shareUrl;
        if (linked) {
          const summaryText = summary.ok ? summary.text : body.trim() ? `Summary unavailable (${summary.reason}).` : 'Nothing could be transcribed.';
          await send(composeSummaryMessage({ summary: summaryText, url: stored.shareUrl, expiresAt: stored.shareExpiresAt }));
        } else {
          if (summary.ok) for (const p of splitMessage(summary.text, 1900)) await send(p);
          else if (body.trim()) await send(`Summary unavailable (${summary.reason}). The transcript is complete.`);
          if (wantSave && !stored.ok) {
            await send(`This transcript could not be saved for the web page and questions (${stored.reason}). ${post ? 'The file above is the only copy.' : 'The file attached to the next message is the only copy.'}`);
            if (!post) await io.dm('Transcript file', { file: transcriptFile }); // posting is off, so the file has not been sent anywhere yet
          }
        }
      } catch {
        notes.push('could not deliver the summary message'); // never include the link or any text in notes or logs
      }
    }

    // 5. Audio backup (pilot). Only when a backup channel is configured; otherwise audio is simply deleted with the work folder.
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

    return { ok: true, id, notes, stats: { speakers: stats.speakers.length, batches: stats.batches, failed: stats.failedBatches, fallback: stats.fallbackBatches, dropped: stats.droppedSegments }, stored: stored.ok, summarised: summary.ok };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
