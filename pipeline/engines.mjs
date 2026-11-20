// Which transcription engines run, and in what order (ENGINE_ORDER, default "parakeet,groq").
//   parakeet  Parakeet TDT 0.6B v2 on the runner's CPU (pipeline/parakeet.mjs): no audio leaves the machine
//   groq      Groq Whisper (needs GROQ_API_KEY)
// The first available engine is the main one and the second is the fallback. An engine that cannot start (no Python, no model,
// no key) is left out and the next one takes its place. Logs engine names and short fixed reasons only.
import { GroqEngine } from './groq.mjs';
import { ParakeetEngine } from './parakeet.mjs';

export const ENGINE_NAMES = ['parakeet', 'groq'];
export const DEFAULT_ENGINE_ORDER = ['parakeet', 'groq'];

/** "groq, Parakeet" -> ['groq', 'parakeet']. Unknown names are ignored; empty means the default. */
export function parseEngineOrder(raw) {
  const names = [...new Set(String(raw ?? '').split(',').map((n) => n.trim().toLowerCase()).filter((n) => ENGINE_NAMES.includes(n)))];
  return names.length ? names : DEFAULT_ENGINE_ORDER;
}

/** What is used when no engine at all is available: every batch fails with a clear reason and gets the visible placeholder. */
const noEngine = () => ({
  name: 'none',
  transcribe: async () => {
    throw Object.assign(new Error('no transcription engine is available'), { kind: 'auth' });
  },
});

/**
 * Creates the engines in order. Parakeet starts loading its model in the background straight away; resolve() waits for it.
 * makeParakeet / makeGroq are replaceable for tests.
 */
export function planEngines({ env, language = 'en', groqKey = '', log = () => {}, makeParakeet = (o) => new ParakeetEngine(o), makeGroq = (o) => new GroqEngine(o) }) {
  const order = parseEngineOrder(env.ENGINE_ORDER);
  const parakeet = order.includes('parakeet') ? makeParakeet({ env }) : null;
  const parakeetReady = parakeet ? parakeet.start() : null;
  const groq = order.includes('groq') && groqKey ? makeGroq({ apiKey: groqKey, model: env.GROQ_MODEL || 'whisper-large-v3', language }) : null;
  if (order.includes('groq') && !groqKey) log('engines: Groq is not configured (GROQ_API_KEY), so it cannot be the fallback');
  log(`engines: order ${order.join(', ')}`);

  return {
    order,
    parakeet,
    groq,
    /** { engine, fallbackEngine }: the usable engines in order. Waits for Parakeet's model to finish loading. */
    async resolve() {
      const usable = [];
      for (const name of order) {
        if (name === 'parakeet' && parakeet) {
          const r = await parakeetReady;
          if (r.ok) usable.push(parakeet);
          else log(`engines: Parakeet is not available (${r.reason})`);
        } else if (name === 'groq' && groq) {
          usable.push(groq);
        }
      }
      log(`engines: using ${usable.map((e) => e.name).join(' then ') || 'none'}`);
      return { engine: usable[0] ?? noEngine(), fallbackEngine: usable[1] ?? null, usable };
    },
    async close() {
      await parakeet?.close();
    },
  };
}
