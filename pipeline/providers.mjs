// Chooses which language models write the summary, and in what order (SUMMARY_MODEL_ORDER).
//   cloudflare-llama  Llama 3.3 70B on Cloudflare Workers AI (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)
//   groq-gpt-oss      gpt-oss-120b on Groq (needs GROQ_API_KEY), the fallback
// A provider that is not configured, or whose budget is used up, is skipped. Logs names only, never keys.
import { CloudflareChatClient } from './cloudflare.mjs';
import { FALLBACK_SUFFIX } from './prompts.mjs';
import { ChatClient } from './summary.mjs';

export const KNOWN = ['cloudflare-llama', 'groq-gpt-oss'];
export const DEFAULT_ORDER = ['cloudflare-llama', 'groq-gpt-oss'];

/** "groq-gpt-oss, cloudflare-llama" -> ['groq-gpt-oss', 'cloudflare-llama']. Unknown names are ignored; empty means the default. */
export function parseOrder(raw) {
  const names = [...new Set(String(raw ?? '').split(',').map((n) => n.trim().toLowerCase()).filter((n) => KNOWN.includes(n)))];
  return names.length ? names : DEFAULT_ORDER;
}

/**
 * Returns [{ name, label, chat, systemSuffix }] in the order to try them.
 * cloudflareAllowed=false (the daily Neuron budget for summaries is used up) leaves Cloudflare out.
 */
export function buildSummaryProviders({ env, cloudflareAllowed = true, log = () => {}, clients = {} }) {
  const providers = [];
  for (const name of parseOrder(env.SUMMARY_MODEL_ORDER)) {
    try {
      if (name === 'cloudflare-llama') {
        if (!cloudflareAllowed) {
          log('summary: the daily Cloudflare budget for summaries is used up; skipping Cloudflare');
          continue;
        }
        if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
          log('summary: Cloudflare is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN); skipping it');
          continue;
        }
        const chat = clients.cloudflare ?? new CloudflareChatClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN });
        providers.push({ name, label: chat.label, chat, systemSuffix: '' });
      } else {
        if (!env.GROQ_API_KEY) {
          log('summary: Groq is not configured (GROQ_API_KEY); skipping it');
          continue;
        }
        const chat = clients.groq ?? new ChatClient({ apiKey: env.GROQ_API_KEY, model: env.LLM_MODEL || 'openai/gpt-oss-120b', reasoningEffort: 'low' });
        providers.push({ name, label: chat.label, chat, systemSuffix: FALLBACK_SUFFIX });
      }
    } catch (e) {
      log(`summary: ${name} could not be set up (${String(e?.message ?? e).slice(0, 80)})`); // messages never contain keys
    }
  }
  return providers;
}
