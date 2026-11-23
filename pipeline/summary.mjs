// Summary and action items from a finished transcript.
// A long meeting is summarised in pieces (about 4,500 tokens each) and the notes are then combined, which keeps every
// request small. The model is chosen by runSummaryChain: Cloudflare Llama 3.3 first, Groq gpt-oss as the fallback.
import { groqRequest, EngineError } from './groq.mjs';
import { chatLimiter } from './limiter.mjs';
import { FALLBACK_SUFFIX, mapSystem, mergeNotesSystem, reduceSystem, singleSystem } from './prompts.mjs';
import { verifySummary } from './verify.mjs';
import { estimateTokens as estimate } from '../src/neurons.js';

// Conservative: real text averages about 4 characters per token, we assume 3.5 so we never go over.
export const estimateTokens = estimate;

// Explicit output limits (B3): a chunk's notes, and the final summary.
export const CHUNK_OUTPUT_TOKENS = 700;
export const FINAL_OUTPUT_TOKENS = 1200;
// The prompt size a single request was budgeted with before the examples were added (see summarize).
export const SINGLE_PROMPT_ALLOWANCE = 450;

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

/** Groq chat (the fallback summary model, and what scripts/transcribe.mjs uses). */
export class ChatClient {
  constructor({ apiKey, model = 'openai/gpt-oss-120b', limiter = chatLimiter(), maxTokens = 2000, reasoningEffort = '', ...rest } = {}) {
    if (!apiKey) throw new EngineError('auth', 'GROQ_API_KEY is missing');
    Object.assign(this, { apiKey, model, limiter, maxTokens, reasoningEffort, rest });
    this.requests = 0;
    this.name = 'groq-gpt-oss';
    this.label = 'GPT-OSS 120B on Groq';
    this.usage = { requests: 0, promptTokens: 0, completionTokens: 0, neurons: 0 }; // Groq spends no Cloudflare Neurons
  }

  async complete(system, user, { maxTokens } = {}) {
    this.requests++;
    const out = maxTokens ?? this.maxTokens;
    const tokens = estimateTokens(system) + estimateTokens(user) + out;
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
          max_completion_tokens: out,
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      ...this.rest,
    });
    this.usage.requests++;
    this.usage.promptTokens += Number(json?.usage?.prompt_tokens) || 0;
    this.usage.completionTokens += Number(json?.usage?.completion_tokens) || 0;
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
 * transcriptBody: the transcript lines without the header. glossary: the team's correct spellings (every prompt lists them).
 * systemSuffix: extra text appended to every prompt (used for the Groq fallback).
 * Returns { ok: true, text, actions, requests } or { ok: false, reason }. Never throws for model problems:
 * a missing summary must not stop the transcript from being posted.
 */
export async function summarize({ transcriptBody, chat, glossary = '', systemSuffix = '', log = () => {}, singleMaxTokens = 5000, chunkTokens = 4500 }) {
  const sys = (build) => build({ glossary }) + systemSuffix;
  const ask = (system, user, maxTokens) => chat.complete(system, user, { maxTokens });
  try {
    if (!String(transcriptBody).trim()) return { ok: false, reason: 'the transcript is empty' };
    let text;
    // One request when the WHOLE request (prompt + transcript) fits. The prompt grew with its few-shot examples (about 1,000
    // tokens); counting it keeps a single request no larger than before (singleMaxTokens of transcript + a ~450-token prompt),
    // which matters for Groq, whose per-minute token limit also caps a single request.
    if (estimateTokens(transcriptBody) + estimateTokens(sys(singleSystem)) <= singleMaxTokens + SINGLE_PROMPT_ALLOWANCE) {
      text = await ask(sys(singleSystem), transcriptBody, FINAL_OUTPUT_TOKENS);
    } else {
      const parts = chunkText(transcriptBody, chunkTokens);
      let notes = [];
      for (let i = 0; i < parts.length; i++) {
        log(`summary: notes for part ${i + 1}/${parts.length}`);
        notes.push(await ask(sys(mapSystem), parts[i], CHUNK_OUTPUT_TOKENS));
      }
      // If the notes are still too long for one request, merge them in groups first.
      while (estimateTokens(notes.join('\n\n')) > singleMaxTokens && notes.length > 1) {
        const groups = chunkText(notes.join('\n\n---\n\n'), chunkTokens);
        if (groups.length >= notes.length) break; // cannot shrink further
        const merged = [];
        for (const g of groups) merged.push(await ask(sys(mergeNotesSystem), g, CHUNK_OUTPUT_TOKENS));
        notes = merged;
      }
      log('summary: combining notes');
      text = await ask(sys(reduceSystem), notes.join('\n\n---\n\n'), FINAL_OUTPUT_TOKENS);
    }
    return { ok: true, text, actions: splitSections(text).actions, requests: chat.requests };
  } catch (e) {
    return { ok: false, reason: `${e.kind || 'error'}: ${e.message}`.slice(0, 200) };
  }
}

/** Removes "(Left out: ...)" lines, which belong to the prompt's examples; a model that copies one must not show it to the team. */
export function stripExampleNotes(text) {
  return String(text)
    .split('\n')
    .filter((line) => !/^\s*\(Left out:.*\)\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const sumUsage = (providers) =>
  providers.reduce(
    (t, p) => ({
      requests: t.requests + (p.chat.usage?.requests ?? 0),
      promptTokens: t.promptTokens + (p.chat.usage?.promptTokens ?? 0),
      completionTokens: t.completionTokens + (p.chat.usage?.completionTokens ?? 0),
      neurons: t.neurons + (p.chat.usage?.neurons ?? 0),
    }),
    { requests: 0, promptTokens: 0, completionTokens: 0, neurons: 0 },
  );

/**
 * Tries each provider in order until one writes the summary: [{ name, label, chat, systemSuffix? }].
 * A provider that fails part-way (a 429, a 5xx, a timeout, an empty answer) is abandoned and the next one starts over
 * from the beginning. The finished summary is checked against the transcript (unmatched items are marked "(unverified)",
 * never deleted) and ends with a footer naming the model that wrote it.
 * Never throws. Logs counts and model names only, never transcript text.
 */
export async function runSummaryChain({ transcriptBody, glossary = '', providers, log = () => {} }) {
  const attempts = [];
  for (const p of providers) {
    log(`summary: trying ${p.name}`);
    const r = await summarize({ transcriptBody, chat: p.chat, glossary, systemSuffix: p.systemSuffix ?? '', log });
    attempts.push({ provider: p.name, ok: r.ok, reason: r.ok ? undefined : r.reason });
    if (!r.ok) {
      log(`summary: ${p.name} failed (${r.reason})`);
      continue;
    }
    const checked = verifySummary({ summaryText: stripExampleNotes(r.text), transcriptBody });
    if (checked.flagged) log(`summary: ${checked.flagged} of ${checked.checked} decisions and action items could not be matched to the transcript (marked unverified)`);
    const text = `${checked.text.trimEnd()}\n\nSummary written by ${p.label}.`;
    return {
      ok: true,
      text,
      actions: splitSections(text).actions,
      requests: r.requests,
      provider: p.name,
      label: p.label,
      fellBack: attempts.length > 1,
      checked: checked.checked,
      flagged: checked.flagged,
      attempts,
      usage: sumUsage(providers),
    };
  }
  return { ok: false, reason: attempts.at(-1)?.reason ?? 'no summary model is configured', attempts, usage: sumUsage(providers) };
}

export { FALLBACK_SUFFIX };

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
