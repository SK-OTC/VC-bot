// Summary and action items from a finished transcript, using a free chat model on Groq.
// Free chat models allow only a few thousand tokens per minute, so a long meeting is summarised in pieces
// (about 4,500 tokens each) and the notes are then combined. This is slow but stays within the limits.
import { groqRequest, EngineError } from './groq.mjs';
import { chatLimiter } from './limiter.mjs';
import { SINGLE_SYSTEM, MAP_SYSTEM, REDUCE_SYSTEM, MERGE_NOTES_SYSTEM } from './prompts.mjs';

// Conservative: real text averages about 4 characters per token, we assume 3.5 so we never go over.
export const estimateTokens = (s) => Math.ceil(String(s).length / 3.5);

/** Splits transcript text into pieces of at most maxTokens, always on line boundaries. */
export function chunkText(text, maxTokens = 4500) {
  const maxChars = Math.floor(maxTokens * 3.5);
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur) chunks.push(cur.trimEnd());
    cur = '';
  };
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (line.length > maxChars) {
      // one enormous line: cut it at the last space before the limit
      const cut = line.lastIndexOf(' ', maxChars) > 0 ? line.lastIndexOf(' ', maxChars) : maxChars;
      push();
      chunks.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    if (cur.length + line.length + 1 > maxChars) push();
    cur += line + '\n';
  }
  push();
  return chunks.filter((c) => c.trim());
}

export class ChatClient {
  constructor({ apiKey, model = 'openai/gpt-oss-120b', limiter = chatLimiter(), maxTokens = 2000, ...rest } = {}) {
    if (!apiKey) throw new EngineError('auth', 'GROQ_API_KEY is missing');
    Object.assign(this, { apiKey, model, limiter, maxTokens, rest });
    this.requests = 0;
  }

  async complete(system, user) {
    this.requests++;
    const tokens = estimateTokens(system) + estimateTokens(user) + this.maxTokens;
    const json = await groqRequest({
      path: '/chat/completions',
      apiKey: this.apiKey,
      limiter: this.limiter,
      request: { tokens },
      headers: { 'Content-Type': 'application/json' },
      buildBody: () =>
        JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_completion_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      ...this.rest,
    });
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new EngineError('bad_request', 'the model returned an empty answer');
    return text.trim();
  }
}

/** Splits the final answer into the summary part and the action-item part (for storage). */
export function splitSections(text) {
  const m = /\*\*Action items\*\*\s*\n([\s\S]*?)(?=\n\*\*[A-Za-z ]+\*\*|\s*$)/i.exec(text);
  return { summary: text.trim(), actions: m ? m[1].trim() : '' };
}

/**
 * transcriptBody: the transcript lines without the header.
 * Returns { ok: true, text, actions, requests } or { ok: false, reason }. Never throws for model problems:
 * a missing summary must not stop the transcript from being posted.
 */
export async function summarize({ transcriptBody, chat, log = () => {}, singleMaxTokens = 5000, chunkTokens = 4500 }) {
  try {
    if (!String(transcriptBody).trim()) return { ok: false, reason: 'the transcript is empty' };
    let text;
    if (estimateTokens(transcriptBody) <= singleMaxTokens) {
      text = await chat.complete(SINGLE_SYSTEM, transcriptBody);
    } else {
      const parts = chunkText(transcriptBody, chunkTokens);
      let notes = [];
      for (let i = 0; i < parts.length; i++) {
        log(`summary: notes for part ${i + 1}/${parts.length}`);
        notes.push(await chat.complete(MAP_SYSTEM, parts[i]));
      }
      // If the notes are still too long for one request, merge them in groups first.
      while (estimateTokens(notes.join('\n\n')) > singleMaxTokens && notes.length > 1) {
        const groups = chunkText(notes.join('\n\n---\n\n'), chunkTokens);
        if (groups.length >= notes.length) break; // cannot shrink further
        const merged = [];
        for (const g of groups) merged.push(await chat.complete(MERGE_NOTES_SYSTEM, g));
        notes = merged;
      }
      log('summary: combining notes');
      text = await chat.complete(REDUCE_SYSTEM, notes.join('\n\n---\n\n'));
    }
    return { ok: true, text, actions: splitSections(text).actions, requests: chat.requests };
  } catch (e) {
    return { ok: false, reason: `${e.kind || 'error'}: ${e.message}`.slice(0, 200) };
  }
}

/** Splits long text into messages under Discord's 2,000-character limit, on line boundaries. */
export function splitMessage(text, max = 1900) {
  const out = [];
  let cur = '';
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (line.length > max) {
      // a single line longer than the limit used to be cut off and lost; now it is split
      if (cur) out.push(cur);
      cur = '';
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}
