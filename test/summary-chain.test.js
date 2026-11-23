import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareChatClient } from '../pipeline/cloudflare.mjs';
import { EngineError } from '../pipeline/groq.mjs';
import { RateLimiter, cfLimiter } from '../pipeline/limiter.mjs';
import { FALLBACK_SUFFIX, draftMergeSystem, mapSystem, mergeNotesSystem, reduceSystem, singleSystem } from '../pipeline/prompts.mjs';
import { verifySummary, itemWords, parseTranscriptLines, UNVERIFIED } from '../pipeline/verify.mjs';
import { CHUNK_OUTPUT_TOKENS, DEFAULT_SINGLE_MAX_TOKENS, FINAL_OUTPUT_TOKENS, chunkText, estimateTokens, runSummaryChain, summarize } from '../pipeline/summary.mjs';
import { CLOUDFLARE_MODELS, buildSummaryProviders, parseOrder } from '../pipeline/providers.mjs';
import { fetchSummaryBudget } from '../pipeline/budget.mjs';
import { GEMMA_LABEL, GEMMA_MODEL, GPT_OSS_LABEL, GPT_OSS_MODEL, LLAMA_LABEL, LLAMA_MODEL, chatNeurons, embeddingNeurons, secondsUntilMidnightUtc, utcDay } from '../src/neurons.js';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cf-token-that-must-never-appear-anywhere';

// ---------- Neuron arithmetic ----------

test('neurons: the reported figure wins; otherwise the published rates agree with the real probe to four decimal places', () => {
  assert.equal(chatNeurons(LLAMA_MODEL, { neurons: 1.529652714729309, prompt_tokens: 1, completion_tokens: 1 }), 1.529652714729309);
  // the real probe: 42 input + 2 output tokens. Cloudflare reported 1.529653; the published rates give 1.529666 (0.0009% apart)
  assert.ok(Math.abs(chatNeurons(LLAMA_MODEL, { prompt_tokens: 42, completion_tokens: 2 }) - 1.529652714729309) < 1e-4);
  assert.ok(Math.abs(chatNeurons(LLAMA_MODEL, { prompt_tokens: 33_000, completion_tokens: 4000 }) - 1699.4) < 1, 'a 2-hour summary is about 1,700 Neurons');
  for (const bad of [undefined, null, {}, { neurons: -1 }, { neurons: 'x' }, { prompt_tokens: -5 }]) assert.ok(chatNeurons(LLAMA_MODEL, bad) >= 0);
  assert.equal(chatNeurons(LLAMA_MODEL, undefined), 0);
  assert.equal(embeddingNeurons('@cf/baai/bge-base-en-v1.5', 1_000_000), 6058);
  assert.equal(embeddingNeurons('unknown-model', 1000), 0);
});

test('neurons: the UTC day and the time until it resets', () => {
  const t = Date.UTC(2026, 10, 19, 23, 59, 0) / 1000;
  assert.equal(utcDay(t), '2026-11-19');
  assert.equal(utcDay(t + 60), '2026-11-20');
  assert.equal(secondsUntilMidnightUtc(t), 60);
  assert.equal(secondsUntilMidnightUtc(Date.UTC(2026, 10, 20, 0, 0, 0) / 1000), 86_400);
});

// ---------- the Cloudflare chat client ----------

const okBody = (text = 'hello', usage = { prompt_tokens: 42, completion_tokens: 2, total_tokens: 44, neurons: 1.5297 }) =>
  new Response(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ message: { content: text } }], usage }), { status: 200 });

function makeClient(handler, over = {}) {
  const calls = [];
  const sleeps = [];
  const client = new CloudflareChatClient({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    sleep: async (ms) => { sleeps.push(ms); },
    limiter: new RateLimiter({ limits: [], sleep: async () => {} }),
    fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return handler(calls.length, calls.at(-1)); },
    ...over,
  });
  return { client, calls, sleeps };
}

test('cloudflare client: sends the right request to the OpenAI-compatible path and reads text, usage and Neurons', async () => {
  const { client, calls } = makeClient(() => okBody('  the answer  '));
  assert.equal(await client.complete('SYS', 'USER', { maxTokens: 700 }), 'the answer');
  const c = calls[0];
  assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(c.body.model, LLAMA_MODEL);
  assert.equal(c.body.max_tokens, 700);
  assert.deepEqual(c.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  assert.deepEqual(client.usage, { requests: 1, promptTokens: 42, completionTokens: 2, neurons: 1.5297 });
  assert.equal(client.name, 'cloudflare-llama');
  assert.equal(client.label, LLAMA_LABEL);
  await client.complete('S', 'U'); // default output limit
  assert.equal(calls[1].body.max_tokens, 1200);
  assert.equal(client.usage.neurons, 3.0594);
});

test('cloudflare client: a named model, extra request fields and temperature; an answer cut off while thinking says so', async () => {
  const { client, calls } = makeClient(() => okBody('ok'), { model: GEMMA_MODEL, name: 'cloudflare-gemma', label: GEMMA_LABEL, extraBody: { chat_template_kwargs: { enable_thinking: false } }, temperature: 0 });
  await client.complete('S', 'U', { maxTokens: 2000 });
  assert.equal(calls[0].body.model, GEMMA_MODEL);
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].body.max_tokens, 2000);
  assert.equal(client.name, 'cloudflare-gemma');
  assert.equal(client.label, GEMMA_LABEL);
  const cut = makeClient(() => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 3000, neurons: 82 } }), { status: 200 }));
  await assert.rejects(cut.client.complete('S', 'U'), (e) => e.kind === 'bad_request' && /whole output limit without an answer/.test(e.message));
  assert.equal(cut.client.usage.neurons, 82, 'the Neurons are counted even though there was no answer');
  // the rates for the new models, for when Cloudflare does not report Neurons (checked against real responses on 2026-11-23)
  assert.ok(Math.abs(chatNeurons(GEMMA_MODEL, { prompt_tokens: 8385, completion_tokens: 596 }) - 92.5) < 0.5, 'Cloudflare reported 92.5');
  assert.ok(Math.abs(chatNeurons(GPT_OSS_MODEL, { prompt_tokens: 7592, completion_tokens: 2027 }) - 379.77) < 0.5, 'Cloudflare reported 379.77');
});

test('cloudflare client: when usage has no Neuron figure it is worked out from the tokens', async () => {
  const { client } = makeClient(() => okBody('x', { prompt_tokens: 1_000_000, completion_tokens: 0 }));
  await client.complete('s', 'u');
  assert.equal(client.usage.neurons, 26_668);
});

test('cloudflare client: needs a token and a 32-character account id, and says so without echoing either', () => {
  assert.throws(() => new CloudflareChatClient({ accountId: ACCOUNT, apiToken: '' }), (e) => e instanceof EngineError && e.kind === 'auth');
  for (const bad of ['', 'short', 'g'.repeat(32), `${ACCOUNT}/../x`, `${ACCOUNT}?x=1`]) {
    assert.throws(() => new CloudflareChatClient({ accountId: bad, apiToken: TOKEN }), (e) => e.kind === 'auth' && !e.message.includes(TOKEN));
  }
});

test('cloudflare client: rejected token, bad request and refusals never include the token or the response body', async () => {
  const secretBody = `${TOKEN} SECRET-BODY-TEXT`;
  for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [400, 'bad_request'], [404, 'bad_request'], [422, 'bad_request']]) {
    const { client, calls } = makeClient(() => new Response(secretBody, { status }));
    await assert.rejects(client.complete('s', 'u'), (e) => e instanceof EngineError && e.kind === kind && !e.message.includes('SECRET-BODY') && !e.message.includes(TOKEN));
    assert.equal(calls.length, 1, `HTTP ${status} is not retried`);
  }
});

test('cloudflare client: a 429 asking for a long wait (daily allowance) gives up at once so the fallback can take over', async () => {
  const { client, calls } = makeClient(() => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(client.complete('s', 'u'), (e) => e.kind === 'rate_limit_exhausted');
  assert.equal(calls.length, 1);
});

test('cloudflare client: a short 429 or a 5xx is retried with backoff, then succeeds', async () => {
  const flaky = makeClient((n) => (n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : n === 2 ? new Response('', { status: 503 }) : okBody('fine')));
  assert.equal(await flaky.client.complete('s', 'u'), 'fine');
  assert.equal(flaky.calls.length, 3);
  assert.deepEqual(flaky.sleeps, [3000]); // the 503 backs off 3 s (the 429 is handled by the rate limiter's own block)
});

test('cloudflare client: gives up after 3 tries (5xx, network error, timeout) with a short fixed reason', async () => {
  const cases = [
    [() => new Response('boom', { status: 500 }), /server error \(HTTP 500\)/, 'transient'],
    [() => { throw new Error(`down ${TOKEN}`); }, /network error/, 'transient'],
    [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, /timeout/, 'transient'],
    [() => new Response('', { status: 429 }), /rate limited/, 'rate_limit_exhausted'],
  ];
  for (const [handler, pattern, kind] of cases) {
    const { client, calls, sleeps } = makeClient(handler);
    await assert.rejects(client.complete('s', 'u'), (e) => e.kind === kind && pattern.test(e.message) && !e.message.includes(TOKEN) && /3 tries/.test(e.message));
    assert.equal(calls.length, 3);
    if (kind === 'transient') assert.deepEqual(sleeps, [1000, 3000]);
  }
});

test('cloudflare client: every call has a 60 second timeout signal', async () => {
  const { client, calls } = makeClient(() => okBody());
  await client.complete('s', 'u');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(client.timeoutMs, 60_000);
});

test('cloudflare client: an empty or unreadable answer is an error, but the Neurons it cost are still counted', async () => {
  const empty = makeClient(() => okBody('   ', { prompt_tokens: 10, completion_tokens: 5, neurons: 2.5 }));
  await assert.rejects(empty.client.complete('s', 'u'), (e) => e.kind === 'bad_request');
  assert.equal(empty.client.usage.neurons, 2.5);
  const junk = makeClient(() => new Response('not json', { status: 200 }));
  await assert.rejects(junk.client.complete('s', 'u'), (e) => e.kind === 'bad_request');
});

test('cfLimiter: 20 requests a minute, the 21st waits for the window to move on', async () => {
  let now = 0;
  const waits = [];
  const limiter = cfLimiter({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  for (let i = 0; i < 20; i++) await limiter.acquire({ requests: 1 });
  assert.deepEqual(waits, []);
  await limiter.acquire({ requests: 1 });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 60_000 - 1, 'waited about a minute');
  assert.equal(limiter.limits[0].cap, 20);
});

// ---------- prompts ----------

test('prompts: every prompt lists the glossary spellings and forbids invention; the final ones ask for one Next steps list', () => {
  const g = 'LiteCut, CapCut=Cap Cut, Zoe';
  for (const build of [singleSystem, mapSystem, reduceSystem, mergeNotesSystem, draftMergeSystem]) {
    const p = build({ glossary: g });
    assert.match(p, /always spell them exactly like this\): LiteCut, CapCut, Zoe\./); // the "=mishearing" part is not shown
    assert.match(p, /never invent owners, deadlines, numbers or names/i);
    assert.match(p, /\[hh:mm:ss\]/);
    assert.doesNotMatch(p, /Cap Cut/);
  }
  for (const build of [singleSystem, reduceSystem, draftMergeSystem]) {
    assert.match(build(), /\*\*Next steps\*\*\n- Owner: task/);
    assert.match(build(), /"Unassigned"/);
  }
  assert.match(mapSystem(), /NEXT STEPS/);
  assert.match(FALLBACK_SUFFIX, /Do not add information that is not in the transcript\./);
});

test('one request when the whole request (prompt + transcript) fits the provider\'s limit; otherwise it is split', async () => {
  const calls = [];
  const chat = { requests: 0, async complete(system) { calls.push(system); this.requests++; return '**Next steps**\n- None recorded'; } };
  const lineOf = (i) => `[00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}] Sam: we talked about the shoe launch plan and the budget for it`;
  const body = (tokens) => { const out = []; for (let i = 0; estimateTokens(out.join('\n')) < tokens; i++) out.push(lineOf(i)); return out.join('\n'); };
  const promptTokens = estimateTokens(singleSystem());
  await summarize({ transcriptBody: body(2000), chat });
  assert.equal(calls.length, 1, 'a short meeting is one request at the default (Groq-sized) limit');
  calls.length = 0;
  await summarize({ transcriptBody: body(DEFAULT_SINGLE_MAX_TOKENS - promptTokens + 50), chat });
  assert.ok(calls.length >= 2, 'just over the default limit it is split');
  calls.length = 0;
  await summarize({ transcriptBody: body(30_000), chat, singleMaxTokens: 200_000 });
  assert.equal(calls.length, 1, 'a long meeting is still one request when the model takes it (Gemma 4: 256k context)');
});

// ---------- the timestamp check (B5) ----------

const TRANSCRIPT = [
  'MEETING TRANSCRIPT',
  '',
  '[00:10:00] Sam: we need to send the pricing deck to the board',
  '[00:10:20] Alice: I can send the pricing deck by Friday',
  '[00:10:45] Sam: great, and we decided to move the launch to March',
  '[00:25:00] Alice: unrelated chat about lunch plans',
].join('\n');

const SUMMARY = `**Summary**
- Pricing and launch were discussed [00:10:00]

**Decisions**
- Move the launch to March [00:10:45]
- Hire three engineers [00:10:45]

**Action items**
- Alice: send the pricing deck [00:10:20]
- Sam: book the venue in Lisbon [00:10:00]
- Unassigned: review the roadmap
- None recorded

**Open questions**
- Who owns the budget? [00:25:00]`;

test('verify: items that match the transcript pass; invented or untimed ones are kept and marked (unverified)', () => {
  const r = verifySummary({ summaryText: SUMMARY, transcriptBody: TRANSCRIPT });
  const lines = r.text.split('\n');
  const find = (s) => lines.find((l) => l.includes(s));
  assert.ok(!find('Move the launch').includes(UNVERIFIED));
  assert.ok(!find('send the pricing deck').includes(UNVERIFIED));
  assert.ok(find('Hire three engineers').endsWith(` ${UNVERIFIED}`), 'invented decision');
  assert.ok(find('book the venue in Lisbon').endsWith(` ${UNVERIFIED}`), 'invented action item');
  assert.ok(find('review the roadmap').endsWith(` ${UNVERIFIED}`), 'no timestamp, so it cannot be located');
  assert.ok(!find('None recorded').includes(UNVERIFIED));
  assert.ok(!find('Who owns the budget').includes(UNVERIFIED), 'open questions and the summary are not checked');
  assert.ok(!find('Pricing and launch').includes(UNVERIFIED));
  assert.equal(r.checked, 5);
  assert.equal(r.flagged, 3);
  assert.equal(lines.length, SUMMARY.split('\n').length, 'nothing is ever deleted');
});

test('verify: the two checks are 30 seconds for lines near the timestamp and 60 seconds for the words, from the end of a line', () => {
  // a 6-word line lasts 5 seconds (the minimum), so 00:10:00 covers until 00:10:05
  const body = ['[00:10:00] A: the quarterly budget forecast needs revision', '[00:12:00] B: nothing relevant here at all'].join('\n');
  const item = (ts) => `**Action items**\n- A: revise the quarterly budget forecast [${ts}]`;
  const flagged = (ts) => verifySummary({ summaryText: item(ts), transcriptBody: body }).flagged;
  assert.equal(flagged('00:10:00'), 0);
  assert.equal(flagged('00:10:35'), 0); // 30 s after the line ends: a line exists near it, and the words are within 60 s
  assert.equal(flagged('00:10:36'), 1); // 31 s after the line ends: check 1 fails
  assert.equal(flagged('00:11:00'), 1); // no line within 30 s
  // a long explanation covers the time it takes to say (2.5 words a second), up to the next line
  const long = `[00:24:06] Farah: ${'we talk about many pre-processing things here '.repeat(30).trim()} and Saad's team may be handling the probe check`;
  const longBody = [long, '[00:26:00] B: ok'].join('\n');
  assert.equal(verifySummary({ summaryText: '**Next steps**\n- Farah: ask Saad whether his team is handling the probe [00:25:30]', transcriptBody: longBody }).flagged, 0, '84 s into a ~2-minute line');
  const words = long.split(': ').slice(1).join(': ').split(/\s+/).length; // 219 words, about 88 s
  assert.equal(parseTranscriptLines(longBody)[0].end, 24 * 60 + 6 + Math.min(114, words / 2.5), 'the line ends when its words are said');
  assert.equal(parseTranscriptLines('[00:00:01] A: hi\n[00:00:03] B: yes')[0].end, 3, 'never past the next line');
  const wide = ['[00:10:00] A: the quarterly budget forecast needs revision', '[00:10:50] B: ok'].join('\n');
  assert.equal(verifySummary({ summaryText: item('00:10:50'), transcriptBody: wide }).flagged, 0); // the line is 50 s away: inside 60 s
  const far = ['[00:09:00] A: the quarterly budget forecast needs revision', '[00:10:50] B: ok'].join('\n');
  assert.equal(verifySummary({ summaryText: item('00:10:50'), transcriptBody: far }).flagged, 1); // words 110 s away: outside 60 s
});

test('verify: "Next steps" is checked; [mm:ss], ranges, "**Heading**:" and "## Heading" are read; "Owner: none recorded" is skipped', () => {
  const body = ['[00:24:06] Farah: I will talk to Saad about the probe today', '[00:34:18] Farah: I will check your PR today'].join('\n');
  const notes = [
    'Title',
    '',
    '**Topic**',
    '- Saad owns the probe, says nothing checkable here',
    '',
    '**Next steps**',
    '- Farah: talk to Saad about the probe [00:24:06]',
    '- Farah: check the PR today [00:24:06‑00:24:30]', // a range, with the non-breaking hyphen Groq's model wrote
    '- Farah: check the PR today [34:18]', // [mm:ss]
    '- Farah: book the venue in Lisbon [00:34:18]',
    '- Unassigned: none recorded',
  ].join('\n');
  const r = verifySummary({ summaryText: notes, transcriptBody: body });
  const lines = r.text.split('\n');
  assert.equal(r.checked, 4, 'only the next steps are checked; the "none" line is skipped');
  assert.equal(r.flagged, 2);
  assert.ok(!lines[6].includes(UNVERIFIED));
  assert.ok(lines[7].endsWith(UNVERIFIED), 'the range starts at 00:24:06, where the PR is not mentioned');
  assert.ok(!lines[8].includes(UNVERIFIED), '[34:18] is read as 00:34:18');
  assert.ok(lines[9].endsWith(UNVERIFIED), 'invented');
  assert.ok(!lines[3].includes(UNVERIFIED), 'topic bullets are not checked');
  for (const heading of ['**Next steps**:', '## Next steps']) {
    assert.equal(verifySummary({ summaryText: `${heading}\n- Farah: book the venue in Lisbon [00:34:18]`, transcriptBody: body }).flagged, 1, heading);
  }
  assert.deepEqual(itemWords('- Farah: check the PR today [00:24:06-00:24:30]'), ['check', 'pr', 'today'], 'a range is not read as words; "PR" is');
});

test('verify: needs two of the item\'s words (stems match: sending/send); never doubles the marker; handles odd input', () => {
  const body = '[00:01:00] A: we are sending invoices tomorrow';
  const one = '**Decisions**\n- Cancel the subscription entirely and invoices [00:01:00]';
  assert.equal(verifySummary({ summaryText: one, transcriptBody: body }).flagged, 1); // only "invoices" matches
  const two = '**Decisions**\n- Send invoices tomorrow [00:01:00]';
  assert.equal(verifySummary({ summaryText: two, transcriptBody: body }).flagged, 0); // "send" ~ "sending", "invoices", "tomorrow"
  const again = verifySummary({ summaryText: verifySummary({ summaryText: one, transcriptBody: body }).text, transcriptBody: body });
  assert.equal((again.text.match(/unverified/g) ?? []).length, 1);
  assert.deepEqual(verifySummary({ summaryText: '', transcriptBody: '' }), { text: '', checked: 0, flagged: 0 });
  assert.equal(verifySummary({ summaryText: null, transcriptBody: undefined }).flagged, 0);
  assert.deepEqual(itemWords('- Alice: Send the pricing deck [00:10:20]'), ['send', 'pricing', 'deck']);
  assert.equal(parseTranscriptLines('junk\n[00:00:05] Alice: hello\n[bad] x: y').length, 1);
});

// ---------- summaries with explicit output limits and the glossary ----------

const GOOD = '**Summary**\n- ok [00:10:00]\n\n**Decisions**\n- None recorded\n\n**Action items**\n- Alice: send the pricing deck [00:10:20]\n\n**Open questions**\n- None';

function recorder(reply = GOOD) {
  const calls = [];
  return { calls, requests: 0, usage: { requests: 0, promptTokens: 0, completionTokens: 0, neurons: 0 }, async complete(system, user, opts) { calls.push({ system, user, maxTokens: opts?.maxTokens }); this.requests++; return typeof reply === 'function' ? reply(calls.length) : reply; } };
}

test('summarize: a short meeting is one request limited to 1,500 output tokens by default, with the glossary and context', async () => {
  const chat = recorder();
  const r = await summarize({ transcriptBody: TRANSCRIPT, chat, glossary: 'LiteCut', context: 'Meeting context (from the recording, not the conversation):\n- Meeting name: X' });
  assert.equal(r.ok, true);
  assert.equal(r.drafts, 1);
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0].maxTokens, FINAL_OUTPUT_TOKENS);
  assert.equal(FINAL_OUTPUT_TOKENS, 1500);
  assert.match(chat.calls[0].system, /LiteCut/);
  assert.match(chat.calls[0].system, /- Meeting name: X/);
  await summarize({ transcriptBody: TRANSCRIPT, chat, finalTokens: 5000 });
  assert.equal(chat.calls[1].maxTokens, 5000, 'a provider can raise the limit (a reasoning model thinks inside it)');
});

test('summarize: a meeting too long for one request makes 1,200-token detailed notes per part, then the final notes', async () => {
  const chat = recorder((n) => (n < 99 ? '- note [00:00:01]' : GOOD));
  const long = Array.from({ length: 4000 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}:00] Sam: line number ${i} with some words about the topic`).join('\n');
  const r = await summarize({ transcriptBody: long, chat, glossary: 'LiteCut', chunkTokens: 4500, drafts: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.drafts, 1, 'drafts apply to a single request only');
  const parts = chunkText(long, 4500).length;
  assert.ok(parts > 1);
  const maps = chat.calls.filter((c) => /ONE PART/.test(c.system));
  assert.equal(maps.length, parts);
  assert.ok(maps.every((c) => c.maxTokens === CHUNK_OUTPUT_TOKENS && CHUNK_OUTPUT_TOKENS === 1200));
  const last = chat.calls.at(-1);
  assert.match(last.system, /keep every specific detail and every next step with its \[hh:mm:ss\]/);
  assert.equal(last.maxTokens, FINAL_OUTPUT_TOKENS);
  assert.ok(chat.calls.every((c) => /LiteCut/.test(c.system)));
  assert.ok(chunkText(long, 4500).every((c) => c.length <= 4500 * 3.5), 'the 4,500-token chunk limit is kept');
});

test('summarize: the Groq fallback suffix is added to every prompt', async () => {
  const chat = recorder();
  await summarize({ transcriptBody: TRANSCRIPT, chat, systemSuffix: FALLBACK_SUFFIX });
  assert.ok(chat.calls[0].system.endsWith('Do not add information that is not in the transcript.'));
});

test('drafts: 2 makes two drafts of the whole meeting and merges them; a failed second draft or merge falls back to draft 1', async () => {
  const chat = recorder((n) => (n === 1 ? 'Title\n\n**A**\n- first draft point\n(Left out: x.)\n\n**Next steps**\n- None recorded' : n === 2 ? 'Title\n\n**A**\n- second draft point' : 'MERGED'));
  const logs = [];
  const r = await summarize({ transcriptBody: TRANSCRIPT, chat, drafts: 2, finalTokens: 2000, log: (m) => logs.push(m) });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'MERGED');
  assert.equal(r.drafts, 2);
  assert.equal(chat.calls.length, 3);
  assert.ok(chat.calls.every((c) => c.maxTokens === 2000));
  assert.equal(chat.calls[0].system, chat.calls[1].system, 'both drafts get the same prompt');
  assert.equal(chat.calls[0].user, chat.calls[1].user, 'both drafts see the whole transcript');
  assert.match(chat.calls[2].system, /two drafts of notes for the SAME meeting/);
  assert.match(chat.calls[2].user, /^DRAFT 1:\nTitle[\s\S]*first draft point[\s\S]*\n\n=====\n\nDRAFT 2:\nTitle[\s\S]*second draft point$/);
  assert.ok(!chat.calls[2].user.includes('Left out'), 'the example note is stripped before the merge');
  assert.ok(!logs.join('\n').includes('draft point'), 'logs never hold summary text');

  const flaky = recorder((n) => { if (n === 1) return 'FIRST'; throw Object.assign(new Error('Cloudflare: server error (HTTP 503) after 3 tries'), { kind: 'transient' }); });
  const r2 = await summarize({ transcriptBody: TRANSCRIPT, chat: flaky, drafts: 2, log: (m) => logs.push(m) });
  assert.equal(r2.ok, true);
  assert.equal(r2.text, 'FIRST');
  assert.equal(r2.drafts, 1);
  assert.ok(logs.some((l) => /second draft or the merge failed \(transient\); using the first draft/.test(l)));

  const mergeFails = recorder((n) => { if (n < 3) return `DRAFT${n}`; throw Object.assign(new Error('x'), { kind: 'bad_request' }); });
  assert.equal((await summarize({ transcriptBody: TRANSCRIPT, chat: mergeFails, drafts: 2 })).text, 'DRAFT1');

  const firstFails = recorder(() => { throw Object.assign(new Error('down'), { kind: 'transient' }); });
  assert.equal((await summarize({ transcriptBody: TRANSCRIPT, chat: firstFails, drafts: 2 })).ok, false, 'no first draft: the provider failed');
});

// ---------- the fallback chain (B6) ----------

const provider = (name, label, chat, systemSuffix = '') => ({ name, label, chat, systemSuffix });
const failing = (usageNeurons = 0) => {
  const c = recorder(() => { throw Object.assign(new Error('Cloudflare: server error (HTTP 503) after 3 tries'), { kind: 'transient' }); });
  c.complete = async function () { this.usage.neurons += usageNeurons; this.usage.requests++; throw Object.assign(new Error('Cloudflare: server error (HTTP 503) after 3 tries'), { kind: 'transient' }); };
  return c;
};

test('chain: Cloudflare writes it, the checked summary ends with a footer naming the model, and usage is reported', async () => {
  const cf = recorder();
  cf.usage = { requests: 1, promptTokens: 900, completionTokens: 300, neurons: 85.5 };
  const logs = [];
  const r = await runSummaryChain({ transcriptBody: TRANSCRIPT, glossary: 'LiteCut', providers: [provider('cloudflare-llama', LLAMA_LABEL, cf)], log: (m) => logs.push(m) });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'cloudflare-llama');
  assert.equal(r.fellBack, false);
  assert.ok(r.text.endsWith(`Summary written by ${LLAMA_LABEL}.`));
  assert.match(r.actions, /Alice: send the pricing deck/);
  assert.equal(r.checked, 1);
  assert.equal(r.flagged, 0);
  assert.equal(r.usage.neurons, 85.5);
  assert.ok(!logs.join('\n').includes('pricing deck'), 'logs hold counts and model names, never transcript text');
});

test('chain: when Cloudflare fails Groq starts over with its suffix; the Neurons Cloudflare already spent are still reported', async () => {
  const cf = failing(40);
  const groq = recorder();
  const r = await runSummaryChain({
    transcriptBody: TRANSCRIPT,
    providers: [provider('cloudflare-llama', LLAMA_LABEL, cf), provider('groq-gpt-oss', 'GPT-OSS 120B on Groq', groq, FALLBACK_SUFFIX)],
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'groq-gpt-oss');
  assert.equal(r.fellBack, true);
  assert.ok(r.text.endsWith('Summary written by GPT-OSS 120B on Groq.'));
  assert.deepEqual(r.attempts.map((a) => [a.provider, a.ok]), [['cloudflare-llama', false], ['groq-gpt-oss', true]]);
  assert.match(r.attempts[0].reason, /503/);
  assert.equal(r.usage.neurons, 40);
  assert.match(groq.calls[0].system, /Do not add information that is not in the transcript\.$/);
});

test('chain: if every model fails there is no summary, the reasons are kept, and nothing throws', async () => {
  const r = await runSummaryChain({ transcriptBody: TRANSCRIPT, providers: [provider('a', 'A', failing(5)), provider('b', 'B', failing())] });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.usage.neurons, 5);
  assert.equal((await runSummaryChain({ transcriptBody: TRANSCRIPT, providers: [] })).reason, 'no summary model is configured');
  assert.equal((await runSummaryChain({ transcriptBody: '   ', providers: [provider('a', 'A', recorder())] })).ok, false);
});

test('chain: unmatched items are marked and counted in the result', async () => {
  const invented = GOOD.replace('- Alice: send the pricing deck [00:10:20]', '- Zed: rebuild the data lake [00:10:20]');
  const r = await runSummaryChain({ transcriptBody: TRANSCRIPT, providers: [provider('cloudflare-llama', LLAMA_LABEL, recorder(invented))] });
  assert.equal(r.flagged, 1);
  assert.match(r.text, /rebuild the data lake \[00:10:20\] \(unverified\)/);
});

test('chain: the meeting context reaches the prompt, the provider\'s options are used, and a wrong weekday date is corrected', async () => {
  const reply = 'Pricing check-in\n\n**Pricing**\n- The deck goes to the board\n\n**Next steps**\n- Alice: send the pricing deck by Friday 28 November [00:10:20]';
  const cf = recorder(reply);
  const logs = [];
  const r = await runSummaryChain({
    transcriptBody: TRANSCRIPT,
    meeting: { name: 'Sales', startedAt: '2026-11-23T17:04:00Z', lengthSec: 1500, speakers: ['Sam', 'Alice'] },
    providers: [{ ...provider('cloudflare-gemma', 'Gemma', cf), options: { drafts: 2, finalTokens: 2000, singleMaxTokens: 200_000 } }],
    log: (m) => logs.push(m),
  });
  assert.equal(r.ok, true);
  assert.equal(cf.calls.length, 3, 'two drafts and a merge');
  assert.equal(r.drafts, 2);
  assert.ok(cf.calls.every((c) => c.maxTokens === 2000));
  assert.match(cf.calls[0].system, /- Meeting name: Sales\n- Date: Monday 23 November 2026 \(UTC\)\./);
  assert.match(cf.calls[0].system, /- Speakers \(their Discord names\): Sam, Alice/);
  assert.match(r.text, /by Friday 27 November \[00:10:20\]/, 'the weekday is trusted and the day corrected');
  assert.equal(r.datesFixed, 1);
  assert.match(r.actions, /^- Alice: send the pricing deck by Friday 27 November \[00:10:20\]$/, 'the stored next steps stop before the footer');
  assert.ok(logs.some((l) => /corrected 1 date\(s\)/.test(l)));
  assert.ok(!logs.join('\n').includes('pricing deck'));
});

// ---------- providers and the budget check ----------

test('providers: order parsing, defaults and skipping what is not configured', () => {
  const DEFAULT = ['cloudflare-gemma', 'cloudflare-gpt-oss', 'groq-gpt-oss'];
  assert.deepEqual(parseOrder(undefined), DEFAULT);
  assert.deepEqual(parseOrder('groq-gpt-oss, Cloudflare-Llama ,nonsense,groq-gpt-oss'), ['groq-gpt-oss', 'cloudflare-llama']);
  assert.deepEqual(parseOrder('nonsense'), DEFAULT);

  const logs = [];
  const all = buildSummaryProviders({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, GROQ_API_KEY: 'gsk_x' }, log: (m) => logs.push(m) });
  assert.deepEqual(all.map((p) => p.name), DEFAULT);
  const [gemma, gptOss, groq] = all;
  assert.equal(gemma.chat.model, GEMMA_MODEL);
  assert.equal(gemma.label, GEMMA_LABEL);
  assert.equal(gemma.chat.name, 'cloudflare-gemma');
  assert.deepEqual(gemma.chat.extraBody, { chat_template_kwargs: { enable_thinking: false } }, 'Gemma 4 with thinking off');
  assert.deepEqual(gemma.options, { singleMaxTokens: 200_000, drafts: 2, finalTokens: 2000 });
  assert.equal(gptOss.chat.model, GPT_OSS_MODEL);
  assert.equal(gptOss.label, GPT_OSS_LABEL);
  assert.deepEqual(gptOss.chat.extraBody, {});
  assert.equal(gptOss.options.drafts, 1);
  assert.ok(gptOss.options.finalTokens >= 4000, 'room for its reasoning');
  assert.ok(gemma.options.singleMaxTokens + gemma.options.finalTokens < 256_000);
  assert.ok(gptOss.options.singleMaxTokens + gptOss.options.finalTokens < 128_000);
  assert.ok(CLOUDFLARE_MODELS['cloudflare-llama'].options.singleMaxTokens + CLOUDFLARE_MODELS['cloudflare-llama'].options.finalTokens <= 24_000);
  assert.equal(gemma.systemSuffix, '');
  assert.equal(groq.systemSuffix, FALLBACK_SUFFIX);
  assert.equal(groq.chat.reasoningEffort, 'low');
  assert.ok(groq.options.singleMaxTokens + groq.options.finalTokens <= 8000, "a single Groq request fits the free tier's 8,000 tokens a minute");
  assert.ok(groq.options.chunkTokens + groq.options.chunkOutputTokens + 1000 <= 8000);
  const flipped = buildSummaryProviders({ env: { SUMMARY_MODEL_ORDER: 'groq-gpt-oss,cloudflare-llama', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, GROQ_API_KEY: 'k' } });
  assert.deepEqual(flipped.map((p) => p.name), ['groq-gpt-oss', 'cloudflare-llama']);
  assert.equal(flipped[1].chat.model, LLAMA_MODEL);
  assert.equal(flipped[1].label, LLAMA_LABEL);

  assert.deepEqual(buildSummaryProviders({ env: { GROQ_API_KEY: 'k' }, log: (m) => logs.push(m) }).map((p) => p.name), ['groq-gpt-oss']);
  assert.deepEqual(buildSummaryProviders({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN } }).map((p) => p.name), ['cloudflare-gemma', 'cloudflare-gpt-oss']);
  assert.deepEqual(buildSummaryProviders({ env: {} }), []);
  const budgetLogs = [];
  assert.deepEqual(buildSummaryProviders({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, GROQ_API_KEY: 'k' }, cloudflareAllowed: false, log: (m) => budgetLogs.push(m) }).map((p) => p.name), ['groq-gpt-oss']);
  assert.equal(budgetLogs.filter((l) => /budget for summaries is used up/.test(l)).length, 1, 'said once, not once per Cloudflare model');
  const bad = buildSummaryProviders({ env: { CLOUDFLARE_ACCOUNT_ID: 'not-an-id', CLOUDFLARE_API_TOKEN: TOKEN, GROQ_API_KEY: 'k' }, log: (m) => logs.push(m) });
  assert.deepEqual(bad.map((p) => p.name), ['groq-gpt-oss']);
  assert.ok(!logs.join('\n').includes(TOKEN) && !logs.join('\n').includes('gsk_x'), 'keys never reach the log');
});

test('budget: reads the Worker\'s answer; any trouble means "unknown" so Cloudflare is simply tried', async () => {
  const worker = (body, status = 200) => async (url, init) => {
    worker.seen = { url, auth: init.headers.Authorization };
    return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: 'https://w.example/', secret: 's', fetchImpl: worker({ summary_allowed: true, neurons_today: 120.5, summary_cap: 9500 }) }), { known: true, allowed: true, neurons: 120.5, cap: 9500 });
  assert.equal(worker.seen.url, 'https://w.example/api/ai-budget');
  assert.equal(worker.seen.auth, 'Bearer s');
  assert.equal((await fetchSummaryBudget({ workerUrl: 'https://w.example', secret: 's', fetchImpl: worker({ summary_allowed: false, neurons_today: 9600, summary_cap: 9500 }) })).allowed, false);
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: 'https://w.example', secret: 's', fetchImpl: worker({}, 401) }), { known: false });
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: 'https://w.example', secret: 's', fetchImpl: worker({ nope: 1 }) }), { known: false });
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: 'https://w.example', secret: 's', fetchImpl: async () => { throw new Error('down'); } }), { known: false });
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: '', secret: 's' }), { known: false });
  assert.deepEqual(await fetchSummaryBudget({ workerUrl: 'https://w.example', secret: '' }), { known: false });
});

test('chain: a longer meeting gets a larger word limit in every final prompt', async () => {
  const cf = recorder();
  await runSummaryChain({ transcriptBody: TRANSCRIPT, meeting: { lengthSec: 95 * 60 }, providers: [{ ...provider('cloudflare-gemma', 'Gemma', cf), options: { drafts: 2 } }] });
  assert.equal(cf.calls.length, 3);
  assert.ok(cf.calls.every((c) => /under 750 words/.test(c.system)), 'both drafts and the merge');
  const short = recorder();
  await runSummaryChain({ transcriptBody: TRANSCRIPT, providers: [provider('x', 'X', short)] });
  assert.match(short.calls[0].system, /under 450 words/, 'no length known: 450');
});

test('verify: word forms, names and acronyms count; generic words (dates, "complete") are never the only evidence', async () => {
  const { stem } = await import('../pipeline/verify.mjs');
  for (const [a, b] of [['tests', 'testing'], ['completed', 'complete'], ['planned', 'plan'], ['rotation', 'rotate'], ['handling', 'handle'], ['studies', 'study'], ['validation', 'validate']]) assert.equal(stem(a), stem(b), `${a} ~ ${b}`);
  assert.notEqual(stem('test'), stem('text'));
  const body = [
    '[00:23:17] Shreyas: should I raise a PR now or after the demo tomorrow?',
    '[00:23:21] Farah: you can make the PR now, right after you are done testing',
    '[00:32:22] Farah: ideally I want to complete everything by Friday',
    '[00:34:06] Farah: then I will go over this with Tim when he is available',
  ].join('\n');
  const flagged = (item) => verifySummary({ summaryText: `**Next steps**\n- ${item}`, transcriptBody: body }).flagged;
  assert.equal(flagged('Shreyas: raise a PR after completing the tests [00:23:21]'), 0, '"PR" and "tests"/"testing" count');
  assert.equal(flagged('Farah: go over the plan with Tim when available [00:34:06]'), 0, 'a short name counts');
  assert.equal(flagged('Shreyas: complete the rotation task by Friday [00:32:22]'), 1, 'only "complete" and "Friday" match: generic, so not enough');
  assert.equal(flagged('Shreyas: book the venue in Lisbon [00:23:21]'), 1, 'invented');
  assert.deepEqual(itemWords('- Ana: Add the FPS check and ask Tim [00:01:00]'), ['fps', 'check', 'tim'], '"Add" and "ask" are too common to count');
});
