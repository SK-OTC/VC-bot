// Meaning-based search over a transcript, using Cloudflare Workers AI (embeddings) and Vectorize (vector index).
// It is OPTIONAL and only an upgrade: without the AI and VECTORIZE bindings, or when either one fails, questions are
// answered with keyword search alone and nothing else changes.
//
// Safety rules for this file:
//  * One Vectorize namespace per transcript, and every query names the namespace, so a question can only ever match
//    vectors of the meeting its link opens. Returned ids are checked again before use.
//  * No transcript text, question or name is stored in the vector index: vectors only, ids look like "<transcript>:<chunk>".
//  * Failures are logged by error type only, never with text, questions or ids from the request.
//  * Only long transcripts are indexed (short ones are sent whole, so an index would add cost for nothing).
import { FULL_TRANSCRIPT_CHARS, transcriptSize } from './ask.js';
import { addNeurons } from './meter.js';
import { embeddingNeurons, estimateTokens } from './neurons.js';

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'; // 768 dimensions: create the index with --dimensions=768
export const TOP_SEMANTIC = 8;
const EMBED_BATCH = 50; // texts per Workers AI call (the model accepts up to 100)
const RETRY_AFTER_SEC = 600; // do not retry a failed indexing more often than this
const ID_RE = /^([a-z0-9]{6}):(\d{1,5})$/;

export const embeddingEnabled = (env) => typeof env?.AI?.run === 'function' && typeof env?.VECTORIZE?.upsert === 'function' && typeof env?.VECTORIZE?.query === 'function';

const modelOf = (env) => String(env?.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Embeddings use the same daily Neuron allowance as the chat models. The binding reports no usage, so this is an estimate from the published rate. */
async function meterEmbedding(env, texts, nowSec) {
  try {
    const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
    await addNeurons(env.DB, 'embed', embeddingNeurons(modelOf(env), tokens), nowSec);
  } catch {
    // a missed meter update only means the meter under-counts a little
  }
}

const logFailure = (what, e) => console.error(`${what}: ${String(e?.name ?? 'Error').slice(0, 40)}`);

/** Embeds a list of texts. Returns an array of number arrays, one per text; throws if the answer is not that. */
async function embed(env, texts) {
  const res = await withTimeout(env.AI.run(modelOf(env), { text: texts }), 20_000);
  const vectors = res?.data;
  const ok =
    Array.isArray(vectors) &&
    vectors.length === texts.length &&
    vectors.every((v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n)));
  if (!ok) throw new Error('unexpected embedding answer');
  return vectors;
}

/**
 * Puts every chunk of a transcript into the vector index. Returns { ok: true, chunks } or { ok: false }.
 * Never throws. Sets transcripts.embedded_at only when every chunk went in.
 */
export async function embedTranscript(env, transcriptId, nowSec) {
  try {
    const chunks = (await env.DB.prepare('SELECT seq, text FROM transcript_chunks WHERE transcript_id = ? ORDER BY seq').bind(transcriptId).all()).results;
    if (!chunks.length) return { ok: false };
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embed(env, slice.map((c) => c.text));
      await meterEmbedding(env, slice.map((c) => c.text), nowSec);
      await withTimeout(
        env.VECTORIZE.upsert(slice.map((c, j) => ({ id: `${transcriptId}:${c.seq}`, namespace: transcriptId, values: vectors[j] }))),
        20_000,
      );
    }
    await env.DB.prepare('UPDATE transcripts SET embedded_at = ? WHERE id = ?').bind(nowSec, transcriptId).run();
    return { ok: true, chunks: chunks.length };
  } catch (e) {
    logFailure('indexing a transcript failed', e);
    return { ok: false };
  }
}

/**
 * Indexes a long transcript that has not been indexed yet, at most once per RETRY_AFTER_SEC. Safe to call from
 * anywhere and as often as you like: it does nothing when the bindings are missing, the transcript is short, it is
 * already indexed, or an attempt was made recently. Returns true when it ran an indexing.
 */
export async function embedIfDue(env, transcriptId, nowSec) {
  try {
    if (!embeddingEnabled(env)) return false;
    const size = await transcriptSize(env.DB, transcriptId);
    if (!size.n || size.chars <= FULL_TRANSCRIPT_CHARS) return false;
    // The check and the claim are one statement, so two requests at once cannot both start an indexing.
    const claim = await env.DB
      .prepare('UPDATE transcripts SET embed_tried_at = ? WHERE id = ? AND embedded_at IS NULL AND (embed_tried_at IS NULL OR embed_tried_at <= ?)')
      .bind(nowSec, transcriptId, nowSec - RETRY_AFTER_SEC)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) return false;
    return (await embedTranscript(env, transcriptId, nowSec)).ok;
  } catch (e) {
    logFailure('indexing check failed', e);
    return false;
  }
}

/**
 * The chunk numbers closest in meaning to the question, best first, for THIS transcript only. Returns [] on any problem
 * (the keyword search then carries the answer alone).
 */
export async function semanticHits(env, transcriptId, question, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    if (!embeddingEnabled(env)) return [];
    const [vector] = await embed(env, [question]);
    await meterEmbedding(env, [question], nowSec);
    const res = await withTimeout(
      env.VECTORIZE.query(vector, { topK: TOP_SEMANTIC, namespace: transcriptId, returnValues: false, returnMetadata: 'none' }),
      8000,
    );
    const hits = [];
    for (const match of Array.isArray(res?.matches) ? res.matches : []) {
      const m = ID_RE.exec(String(match?.id ?? ''));
      // Defence in depth: the namespace already limits the search, but an id from another transcript is never used.
      if (m && m[1] === transcriptId && !hits.includes(Number(m[2]))) hits.push(Number(m[2]));
    }
    return hits;
  } catch (e) {
    logFailure('meaning search failed', e);
    return [];
  }
}

/** Removes a transcript's vectors (for example when the transcript is deleted). Returns how many ids were asked to go. */
export async function deleteEmbeddings(env, transcriptId, chunkCount) {
  if (typeof env?.VECTORIZE?.deleteByIds !== 'function') return 0;
  const ids = Array.from({ length: chunkCount }, (_, seq) => `${transcriptId}:${seq}`);
  for (let i = 0; i < ids.length; i += 500) await env.VECTORIZE.deleteByIds(ids.slice(i, i + 500));
  return ids.length;
}
