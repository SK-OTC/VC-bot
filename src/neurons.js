// Cloudflare Workers AI is billed in Neurons, with 10,000 free per day for the whole account (reset at 00:00 UTC).
// Pure helpers shared by the Worker and the GitHub recorder. Rates are from Cloudflare's pricing page
// (https://developers.cloudflare.com/workers-ai/platform/pricing/); the Llama figures were checked against a real
// response: for 42 input + 2 output tokens they give 1.529666 Neurons and Cloudflare reported 1.529653, which agree to
// four decimal places. The reported figure is always preferred; the rates are only the fallback.

export const LLAMA_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const LLAMA_LABEL = 'Llama 3.3 70B on Cloudflare Workers AI';

/** Neurons per million tokens. */
export const CHAT_RATES = { [LLAMA_MODEL]: { input: 26_668, output: 204_805 } };
export const EMBEDDING_RATES = {
  '@cf/baai/bge-small-en-v1.5': 1841,
  '@cf/baai/bge-base-en-v1.5': 6058,
  '@cf/baai/bge-large-en-v1.5': 18_582,
  '@cf/baai/bge-m3': 1075,
};

/** Conservative: real text averages about 4 characters per token; assuming 3.5 means we never underestimate. */
export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 3.5);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Neurons used by one chat response. Cloudflare reports `usage.neurons` itself; use that when present, otherwise work it
 * out from the token counts with the published rates. Returns 0 when there is nothing to go on.
 */
export function chatNeurons(model, usage) {
  const reported = num(usage?.neurons);
  if (reported !== null) return reported;
  const rate = CHAT_RATES[model] ?? CHAT_RATES[LLAMA_MODEL];
  const input = num(usage?.prompt_tokens) ?? 0;
  const output = num(usage?.completion_tokens) ?? 0;
  return (input * rate.input + output * rate.output) / 1_000_000;
}

/** Neurons for embedding `tokens` input tokens (an estimate: the Workers AI binding does not report usage). 0 for an unknown model. */
export function embeddingNeurons(model, tokens) {
  const rate = EMBEDDING_RATES[model];
  return rate ? (Math.max(0, tokens) * rate) / 1_000_000 : 0;
}

/** The UTC calendar day a Unix time falls on, which is when Cloudflare's daily allowance resets. */
export const utcDay = (nowSec) => new Date(nowSec * 1000).toISOString().slice(0, 10);

/** Seconds from `nowSec` until the next 00:00 UTC. */
export const secondsUntilMidnightUtc = (nowSec) => 86_400 - (nowSec % 86_400);
