// Groq's API (free tier): speech to text (Whisper) and chat (language models).
// The API is OpenAI-compatible. The exact URLs below are assumed from that and must be confirmed on the
// first real call (see README, step 1).
import { readFile } from 'node:fs/promises';
import { whisperLimiter } from './limiter.mjs';

export class EngineError extends Error {
  /** kind: 'auth' | 'bad_request' | 'transient' | 'rate_limit_exhausted' */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to Groq with waiting and retries.
 *  - 429: wait for the retry-after time and try again. A wait over maxRetryAfterSec means the daily limit is used up.
 *  - 5xx or network trouble: back off and retry a few times.
 *  - 401/403/other 4xx: stop immediately with a clear error.
 */
export async function groqRequest({
  baseUrl = process.env.GROQ_BASE_URL || DEFAULT_BASE,
  path,
  apiKey,
  buildBody,
  headers = {},
  limiter,
  request,
  sleep = defaultSleep,
  maxTransientAttempts = 4,
  maxRateLimitWaits = 12,
  maxRetryAfterSec = 900,
}) {
  if (!apiKey) throw new EngineError('auth', 'GROQ_API_KEY is missing');
  let transient = 0;
  let rateWaits = 0;
  for (;;) {
    await limiter.acquire(request);
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, ...headers }, body: buildBody() });
    } catch (e) {
      if (++transient >= maxTransientAttempts) throw new EngineError('transient', `network error: ${e.message}`);
      await sleep(2000 * 2 ** (transient - 1));
      continue;
    }
    if (res.ok) return res.json();

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > maxRetryAfterSec) throw new EngineError('rate_limit_exhausted', `limit reached (retry in ${Math.round(retryAfter / 60)} min)`);
      if (++rateWaits > maxRateLimitWaits) throw new EngineError('rate_limit_exhausted', 'still rate limited after many waits');
      limiter.block(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new EngineError('auth', `Groq rejected the API key (HTTP ${res.status})`);
    if (res.status >= 500) {
      if (++transient >= maxTransientAttempts) throw new EngineError('transient', `Groq server error (HTTP ${res.status})`);
      await sleep(2000 * 2 ** (transient - 1));
      continue;
    }
    const body = (await res.text()).slice(0, 200);
    throw new EngineError('bad_request', `Groq returned HTTP ${res.status}: ${body}`);
  }
}

export class GroqEngine {
  constructor({ apiKey, model = 'whisper-large-v3', language = 'en', limiter = whisperLimiter(), ...rest } = {}) {
    if (!apiKey) throw new EngineError('auth', 'GROQ_API_KEY is missing');
    Object.assign(this, { apiKey, model, language, limiter, rest });
    this.name = `groq ${model}`;
    this.label = 'Groq Whisper'; // how the transcript header names it
  }

  /** Returns [{ start, end, text, avg_logprob, no_speech_prob, compression_ratio }] in the batch's own time. */
  async transcribe(filePath, { prompt = '', durationSec }) {
    const billableSec = Math.max(10, Math.ceil(durationSec)); // Groq bills at least 10 seconds per request
    const bytes = await readFile(filePath);
    const json = await groqRequest({
      path: '/audio/transcriptions',
      apiKey: this.apiKey,
      limiter: this.limiter,
      request: { billableSec },
      buildBody: () => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'audio/flac' }), 'batch.flac');
        form.append('model', this.model);
        form.append('language', this.language);
        form.append('temperature', '0');
        form.append('response_format', 'verbose_json');
        if (prompt) form.append('prompt', prompt);
        return form;
      },
      ...this.rest,
    });
    return parseResponse(json, durationSec);
  }
}

export function parseResponse(json, durationSec) {
  if (Array.isArray(json.segments)) {
    return json.segments
      .map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text ?? ''),
        avg_logprob: s.avg_logprob,
        no_speech_prob: s.no_speech_prob,
        compression_ratio: s.compression_ratio,
      }))
      .sort((a, b) => a.start - b.start);
  }
  if (typeof json.text === 'string') return [{ start: 0, end: durationSec, text: json.text }];
  throw new EngineError('bad_request', 'unexpected response from Groq (no segments or text)');
}
