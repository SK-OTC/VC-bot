// Chooses which language models write the summary, and in what order (SUMMARY_MODEL_ORDER).
//   cloudflare-gemma    Gemma 4 26B-A4B on Cloudflare Workers AI, thinking off, two drafts merged (the default first choice)
//   cloudflare-gpt-oss  gpt-oss-120b on Cloudflare Workers AI (the first fallback)
//   cloudflare-llama    Llama 3.3 70B on Cloudflare Workers AI (the old default; only used if named)
//   groq-gpt-oss        gpt-oss-120b on Groq (needs GROQ_API_KEY), the last fallback
// The Cloudflare ones need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN and share the daily Neuron budget.
// Why this order (tested 2026-11-23 on two real meetings against Granola's notes): Gemma 4 gave the most specific notes,
// left out side chat, and costs about 100 Neurons a request; its runs vary, so two drafts are merged (about 225 Neurons a
// meeting). gpt-oss-120b is detailed but lets side chat through more often, at about 4x the cost. Llama 3.3 was too vague.
// A provider that is not configured, or whose budget is used up, is skipped. Logs names only, never keys.
import { CloudflareChatClient } from './cloudflare.mjs';
import { FALLBACK_SUFFIX } from './prompts.mjs';
import { ChatClient } from './summary.mjs';
import { GEMMA_LABEL, GEMMA_MODEL, GPT_OSS_LABEL, GPT_OSS_MODEL, LLAMA_LABEL, LLAMA_MODEL } from '../src/neurons.js';

/**
 * The Cloudflare models and the settings summarize() uses for each. singleMaxTokens is the largest single request
 * (prompt + transcript), kept well inside the model's context window with room for the answer.
 */
export const CLOUDFLARE_MODELS = {
  'cloudflare-gemma': {
    model: GEMMA_MODEL,
    label: GEMMA_LABEL,
    // with thinking on, Gemma 4 spent 8,000 output tokens reasoning and never wrote the notes; off, it answers in ~600
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    options: { singleMaxTokens: 200_000, drafts: 2, finalTokens: 2000 },
  },
  'cloudflare-gpt-oss': {
    model: GPT_OSS_MODEL,
    label: GPT_OSS_LABEL,
    // a reasoning model: its thinking counts against the output limit (about 1,500-2,000 tokens on a 35-minute meeting)
    options: { singleMaxTokens: 100_000, drafts: 1, finalTokens: 5000 },
  },
  'cloudflare-llama': {
    model: LLAMA_MODEL,
    label: LLAMA_LABEL,
    options: { singleMaxTokens: 20_000, drafts: 1, finalTokens: 1500 }, // 24,000-token context window
  },
};

export const KNOWN = [...Object.keys(CLOUDFLARE_MODELS), 'groq-gpt-oss'];
export const DEFAULT_ORDER = ['cloudflare-gemma', 'cloudflare-gpt-oss', 'groq-gpt-oss'];

// Groq's free tier allows 8,000 tokens a minute, and a single request must fit inside that: a meeting longer than about
// 15 minutes is summarised in parts.
const GROQ_OPTIONS = { singleMaxTokens: 5450, chunkTokens: 4000, drafts: 1, finalTokens: 2000, chunkOutputTokens: 1200 };

/** "groq-gpt-oss, cloudflare-gemma" -> ['groq-gpt-oss', 'cloudflare-gemma']. Unknown names are ignored; empty means the default. */
export function parseOrder(raw) {
  const names = [...new Set(String(raw ?? '').split(',').map((n) => n.trim().toLowerCase()).filter((n) => KNOWN.includes(n)))];
  return names.length ? names : DEFAULT_ORDER;
}

/**
 * Returns [{ name, label, chat, systemSuffix, options }] in the order to try them.
 * cloudflareAllowed=false (the daily Neuron budget for summaries is used up) leaves every Cloudflare model out.
 */
export function buildSummaryProviders({ env, cloudflareAllowed = true, log = () => {}, clients = {} }) {
  const providers = [];
  let budgetLogged = false;
  for (const name of parseOrder(env.SUMMARY_MODEL_ORDER)) {
    try {
      const cf = CLOUDFLARE_MODELS[name];
      if (cf) {
        if (!cloudflareAllowed) {
          if (!budgetLogged) log('summary: the daily Cloudflare budget for summaries is used up; skipping Cloudflare');
          budgetLogged = true;
          continue;
        }
        if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
          log(`summary: Cloudflare is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN); skipping ${name}`);
          continue;
        }
        const chat =
          clients[name] ??
          new CloudflareChatClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, model: cf.model, name, label: cf.label, extraBody: cf.extraBody });
        providers.push({ name, label: chat.label, chat, systemSuffix: '', options: cf.options });
      } else {
        if (!env.GROQ_API_KEY) {
          log('summary: Groq is not configured (GROQ_API_KEY); skipping it');
          continue;
        }
        const chat = clients.groq ?? new ChatClient({ apiKey: env.GROQ_API_KEY, model: env.LLM_MODEL || 'openai/gpt-oss-120b', reasoningEffort: 'low' });
        providers.push({ name, label: chat.label, chat, systemSuffix: FALLBACK_SUFFIX, options: GROQ_OPTIONS });
      }
    } catch (e) {
      log(`summary: ${name} could not be set up (${String(e?.message ?? e).slice(0, 80)})`); // messages never contain keys
    }
  }
  return providers;
}
