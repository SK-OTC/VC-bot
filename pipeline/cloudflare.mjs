// Chat on Cloudflare Workers AI (Llama 3.3 70B) over the OpenAI-compatible REST path, used for the post-meeting summary.
//   POST https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1/chat/completions
// This path returns `usage` including Cloudflare's own `neurons` figure. (The native /ai/run path also echoes the whole
// prompt back in its answer, so it is deliberately not used.) The token is never put in a message, log line or error.
import { EngineError } from './groq.mjs';
import { cfLimiter } from './limiter.mjs';
import { LLAMA_LABEL, LLAMA_MODEL, chatNeurons, estimateTokens } from '../src/neurons.js';

export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const API = 'https://api.cloudflare.com/client/v4';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CloudflareChatClient {
  constructor({
    accountId,
    apiToken,
    model = LLAMA_MODEL,
    limiter = cfLimiter(),
    maxTokens = 1200,
    timeoutMs = 60_000,
    maxAttempts = 3,
    baseUrl = API,
    fetchImpl,
    sleep = defaultSleep,
  } = {}) {
    if (!String(apiToken ?? '').trim()) throw new EngineError('auth', 'CLOUDFLARE_API_TOKEN is missing');
    if (!ACCOUNT_ID_RE.test(String(accountId ?? '').trim())) throw new EngineError('auth', 'CLOUDFLARE_ACCOUNT_ID must be 32 hex characters');
    Object.assign(this, { model, limiter, maxTokens, timeoutMs, maxAttempts, sleep });
    this.url = `${baseUrl}/accounts/${String(accountId).trim()}/ai/v1/chat/completions`;
    this._token = String(apiToken).trim();
    this._fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.name = 'cloudflare-llama';
    this.label = LLAMA_LABEL;
    this.requests = 0;
    this.usage = { requests: 0, promptTokens: 0, completionTokens: 0, neurons: 0 };
  }

  /** Returns the model's text. Throws an EngineError (any kind) when this provider cannot answer, so the caller can fall back. */
  async complete(system, user, { maxTokens } = {}) {
    this.requests++;
    const body = JSON.stringify({
      model: this.model,
      temperature: 0.2,
      max_tokens: maxTokens ?? this.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    let failure = 'transient';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.limiter.acquire({ requests: 1 });
      let res;
      try {
        res = await this._fetch(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        failure = e?.name === 'TimeoutError' ? 'timeout' : 'network error';
        if (attempt < this.maxAttempts) await this.sleep(1000 * 3 ** (attempt - 1));
        continue;
      }
      if (res.ok) return this._read(res, system, user);

      if (res.status === 401 || res.status === 403) throw new EngineError('auth', `Cloudflare rejected the API token (HTTP ${res.status})`);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 60) throw new EngineError('rate_limit_exhausted', 'Cloudflare refused (limit or daily allowance reached)');
        failure = 'rate limited';
        this.limiter.block(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5);
        continue;
      }
      if (res.status >= 500) {
        failure = `server error (HTTP ${res.status})`;
        if (attempt < this.maxAttempts) await this.sleep(1000 * 3 ** (attempt - 1));
        continue;
      }
      throw new EngineError('bad_request', `Cloudflare returned HTTP ${res.status}`); // the body is never included
    }
    throw new EngineError(failure === 'rate limited' ? 'rate_limit_exhausted' : 'transient', `Cloudflare: ${failure} after ${this.maxAttempts} tries`);
  }

  async _read(res, system, user) {
    let json;
    try {
      json = await res.json();
    } catch {
      throw new EngineError('bad_request', 'Cloudflare returned an unreadable answer');
    }
    const text = json?.choices?.[0]?.message?.content;
    const reported = json?.usage;
    // Count what was spent even if the text turns out to be unusable: the Neurons are gone either way.
    const usage = reported ?? { prompt_tokens: estimateTokens(system) + estimateTokens(user), completion_tokens: estimateTokens(text ?? '') };
    this.usage.requests++;
    this.usage.promptTokens += Number(usage.prompt_tokens) || 0;
    this.usage.completionTokens += Number(usage.completion_tokens) || 0;
    this.usage.neurons += chatNeurons(this.model, usage);
    if (typeof text !== 'string' || !text.trim()) throw new EngineError('bad_request', 'the model returned an empty answer');
    return text.trim();
  }
}
