// Step 6 probe: does the Cloudflare REST API answer a tiny chat request on Llama 3.3 70B, on which path, and does it
// report token usage? Makes TWO calls of about 20 tokens each (a few dozen Neurons out of the 10,000 daily allowance).
//
//   $env:CF_ACCOUNT_ID = "..."      # PowerShell; use  export CF_ACCOUNT_ID=...  in bash
//   $env:CF_API_TOKEN  = "..."      # a token limited to "Workers AI" (Read/Edit), nothing else
//   node scripts/spike/cf-probe.mjs
//
// Prints status codes, field NAMES, token counts and timings only. It never prints the token, the account id or any
// text the model wrote, so the output is safe to paste into a chat.
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) {
  console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN in your environment first (never paste them into chat).');
  process.exit(1);
}
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai`;
const messages = [{ role: 'user', content: 'Reply with the single word: ok' }];

async function probe(label, url, body) {
  const t = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.log(`${label}: network error (${e?.name})`);
    return;
  }
  const ms = Date.now() - t;
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // not JSON
  }
  console.log(`\n${label}`);
  console.log(`  HTTP ${res.status} in ${ms} ms`);
  if (!res.ok) {
    // Cloudflare error bodies hold an error code and message, never our token; show only the codes and a short message.
    const errs = (json?.errors ?? []).map((e) => `code ${e.code}: ${String(e.message).slice(0, 120)}`);
    console.log('  errors:', errs.length ? errs.join(' | ') : `(${raw.slice(0, 120).replace(/\s+/g, ' ')})`);
    return;
  }
  const payload = json?.result ?? json; // the native path wraps the answer in { result }, the OpenAI path does not
  console.log('  top-level keys:', Object.keys(json ?? {}).join(', '));
  console.log('  answer keys:', Object.keys(payload ?? {}).join(', '));
  const usage = payload?.usage;
  console.log('  usage reported:', usage ? JSON.stringify(usage) : 'NO');
  console.log('  has choices[0].message.content:', typeof payload?.choices?.[0]?.message?.content === 'string');
  console.log('  has response (native text field):', typeof payload?.response === 'string');
  console.log('  response headers that mention neurons/usage:', [...res.headers.keys()].filter((k) => /neuron|usage|ratelimit/i.test(k)).join(', ') || 'none');
}

console.log(`Model: ${MODEL}`);
await probe('1. OpenAI-compatible path  (/ai/v1/chat/completions)', `${base}/v1/chat/completions`, { model: MODEL, messages, max_tokens: 8 });
await probe('2. Native path            (/ai/run/<model>)', `${base}/run/${MODEL}`, { messages, max_tokens: 8 });
console.log('\nDone. Paste this output back (it contains no secrets or model text).');
