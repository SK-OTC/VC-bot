import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCORD_CONTENT_LIMIT, composeSummaryMessage, linkBlock } from '../pipeline/summary-message.mjs';

const URL_ = `https://worker.example/t/${'A'.repeat(43)}`;
const EXP = 1_800_000_000;
const bullets = (n, width = 60) => Array.from({ length: n }, (_, i) => `- point number ${i} ${'x'.repeat(width)} [00:${String(i % 60).padStart(2, '0')}:00]`).join('\n');

test('the limit used is Discord\'s documented 2000 characters for message content', () => {
  assert.equal(DISCORD_CONTENT_LIMIT, 2000);
});

test('a summary that fits is kept whole, with the link after it and no ellipsis', () => {
  const summary = '**Summary**\n- one [00:00:01]\n\n**Action items**\n- Sam: ship it [00:00:09]';
  const m = composeSummaryMessage({ summary, url: URL_, expiresAt: EXP });
  assert.ok(m.startsWith(summary));
  assert.ok(!m.includes('…'));
  assert.ok(m.endsWith(`Anyone with the link can open and edit it until <t:${EXP}:D>.`));
  assert.ok(m.includes(`<${URL_}>`), 'the link is wrapped in <...> so Discord shows no preview card');
});

test('a summary over the limit is cut at a line boundary, marked with an ellipsis, and the whole link block survives', () => {
  const summary = `**Summary**\n${bullets(80)}`;
  assert.ok(summary.length > 5000);
  const m = composeSummaryMessage({ summary, url: URL_, expiresAt: EXP });
  assert.ok(m.length <= 2000, `message is ${m.length}`);
  assert.ok(m.endsWith(linkBlock(URL_, EXP)), 'the link text is complete and last');
  const shown = m.slice(0, m.length - linkBlock(URL_, EXP).length);
  assert.ok(shown.endsWith('\n…'));
  for (const line of shown.slice(0, -2).split('\n')) assert.ok(summary.split('\n').includes(line), `a cut line: ${line}`); // only whole lines
  assert.ok(m.length > 1700, 'uses most of the room');
});

test('exact boundaries: one character over the limit is cut, exactly at the limit is not', () => {
  const room = DISCORD_CONTENT_LIMIT - linkBlock(URL_, EXP).length;
  const fits = 'a'.repeat(room);
  const exact = composeSummaryMessage({ summary: fits, url: URL_, expiresAt: EXP });
  assert.equal(exact.length, 2000);
  assert.ok(!exact.includes('…'));
  const over = composeSummaryMessage({ summary: `${fits}\nb`, url: URL_, expiresAt: EXP });
  assert.ok(over.length <= 2000);
  assert.ok(over.includes('…'));
  assert.ok(over.endsWith(linkBlock(URL_, EXP)));
});

test('a heading left alone at the cut is dropped, so a section never ends on its own title', () => {
  const room = DISCORD_CONTENT_LIMIT - linkBlock(URL_, EXP).length - 2;
  const first = 'z'.repeat(room - 20);
  const m = composeSummaryMessage({ summary: `${first}\n**Decisions**\n- ${'y'.repeat(100)}`, url: URL_, expiresAt: EXP });
  assert.ok(!m.includes('**Decisions**'));
  assert.ok(m.startsWith(first));
});

test('one huge first line is cut inside the line, never in the middle of an emoji, and still ends with the link', () => {
  const summary = '😀'.repeat(3000);
  const m = composeSummaryMessage({ summary, url: URL_, expiresAt: EXP });
  assert.ok(m.length <= 2000);
  assert.ok(m.endsWith(linkBlock(URL_, EXP)));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(m), 'no broken surrogate pair');
});

test('no expiry given: the link block has no date; an empty summary leaves just the link', () => {
  assert.ok(!linkBlock(URL_).includes('<t:'));
  const m = composeSummaryMessage({ summary: '  ', url: URL_ });
  assert.ok(m.includes(URL_));
  assert.ok(!m.includes('…'));
});

test('a different limit is honoured, and the link is kept even if the limit is absurdly small', () => {
  const m = composeSummaryMessage({ summary: bullets(10), url: URL_, expiresAt: EXP, limit: 600 });
  assert.ok(m.length <= 600);
  assert.ok(m.endsWith(linkBlock(URL_, EXP)));
  const tiny = composeSummaryMessage({ summary: bullets(10), url: URL_, expiresAt: EXP, limit: 50 });
  assert.ok(tiny.includes(`<${URL_}>`));
});
