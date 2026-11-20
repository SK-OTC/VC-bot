import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCase, createGlossaryFixer, levenshtein, loadCommonWords, maxDistanceFor, parseGlossary } from '../pipeline/glossary-fix.mjs';
import { buildPrompt } from '../pipeline/glossary.mjs';

const common = loadCommonWords();
const fixer = (g) => createGlossaryFixer(g, { commonWords: common });
const fix = (g, text, t = 12.5) => fixer(g).fix(text, { t });

// ---------- parsing ----------

test('parseGlossary: terms, listed mishearings, any separator, duplicates and blanks', () => {
  assert.deepEqual(parseGlossary('LiteCut=Lite Cut|Lite cut, CapCut; Zoe\nShopify = shop if i '), [
    { term: 'LiteCut', mishearings: ['Lite Cut', 'Lite cut'] },
    { term: 'CapCut', mishearings: [] },
    { term: 'Zoe', mishearings: [] },
    { term: 'Shopify', mishearings: ['shop if i'] },
  ]);
  assert.deepEqual(parseGlossary('litecut, LiteCut'), [{ term: 'litecut', mishearings: [] }]); // case-insensitive duplicate
  assert.deepEqual(parseGlossary('A=a'), [{ term: 'A', mishearings: [] }]); // a "mishearing" equal to the term is meaningless
  for (const empty of ['', ' ', ',,;\n', null, undefined, '=x']) assert.deepEqual(parseGlossary(empty), []);
  assert.equal(parseGlossary(Array.from({ length: 500 }, (_, i) => `term${i}`).join(',')).length, 200);
});

test('the Whisper prompt and the summary prompts list only the correct spellings, never the mishearings', () => {
  const p = buildPrompt('LiteCut=Lite Cut|Lite cut, CapCut');
  assert.match(p, /LiteCut/);
  assert.match(p, /CapCut/);
  assert.doesNotMatch(p, /Lite Cut|Lite cut|=|\|/);
});

// ---------- edit distance rules ----------

test('levenshtein: insert, delete, substitute; stops early past the limit', () => {
  assert.equal(levenshtein('capcut', 'capcut', 2), 0);
  assert.equal(levenshtein('capcut', 'capcat', 2), 1);
  assert.equal(levenshtein('capcut', 'capcutt', 2), 1);
  assert.equal(levenshtein('capcut', 'capct', 2), 1);
  assert.equal(levenshtein('kitten', 'sitten', 1), 1);
  assert.equal(levenshtein('abc', 'xyz', 1), 2); // more than the limit: limit + 1
  assert.equal(levenshtein('short', 'muchlongerword', 2), 3);
});

test('maxDistanceFor: exact below 5 letters, 1 from 5, 2 from 9', () => {
  assert.deepEqual([3, 4, 5, 8, 9, 14].map((n) => maxDistanceFor('x'.repeat(n))), [0, 0, 1, 1, 2, 2]);
});

// ---------- listed mishearings ----------

test('listed mishearings are always replaced: "Lite Cut" becomes LiteCut, whatever the spacing or case', () => {
  const r = fix('LiteCut=Lite Cut|Lite cut', 'We use Lite Cut and lite   cut and LITE CUT daily.');
  assert.equal(r.text, 'We use LiteCut and LiteCut and LITECUT daily.');
  assert.deepEqual(r.changes.map((c) => c.kind), ['listed', 'listed', 'listed']);
  assert.equal(r.changes[0].from, 'Lite Cut');
  assert.equal(r.changes[0].to, 'LiteCut');
  assert.equal(r.changes[0].t, 12.5);
});

test('listed mishearings work on whole words only, and a listed ordinary word IS replaced (only listed ones may be)', () => {
  assert.equal(fix('LiteCut=Lite Cut', 'Sublite Cutter and Lite Cutter').text, 'Sublite Cutter and Lite Cutter');
  assert.equal(fix('LiteCut=Lite Cut', 'the Lite Cut\'s new feature').text, "the LiteCut's new feature");
  assert.equal(fix('Figma=sigma', 'open sigma now').text, 'open figma now'); // "sigma" is an ordinary word, but it was listed; lower case in, lower case out
  assert.equal(fix('Figma=sigma', 'Open Sigma now').text, 'Open Figma now'); // Title case in, Title case out
  assert.equal(fix('Figma', 'open sigma now').text, 'open sigma now'); // not listed: an ordinary word is never fuzzy-changed
});

test('a longer listed phrase wins over a shorter one it contains', () => {
  const r = fix('LiteCutPro=Lite Cut Pro, LiteCut=Lite Cut', 'try Lite Cut Pro or Lite Cut');
  assert.equal(r.text, 'try LiteCutPro or LiteCut');
});

// ---------- fuzzy matching ----------

test('fuzzy: a misspelling within distance 1 (term of 5+ letters) is corrected; distance 2 is not', () => {
  assert.equal(fix('CapCut', 'I edit in Capcat every day').text, 'I edit in CapCut every day'); // 1 substitution
  assert.equal(fix('CapCut', 'I edit in Capcutt every day').text, 'I edit in CapCut every day'); // 1 insertion
  assert.equal(fix('CapCut', 'I edit in Capxyt every day').text, 'I edit in Capxyt every day'); // 2 away: left alone
  const r = fix('CapCut', 'Capcat is good');
  assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.kind]), [['Capcat', 'CapCut', 'fuzzy']]);
});

test('fuzzy: long terms (9+ letters) allow distance 2, shorter ones do not', () => {
  assert.equal(fix('Salesforce', 'we use Salesforse and Salesfarse').text, 'we use Salesforce and Salesforce'); // 'Salesforce' has 10 letters
  assert.equal(fix('Zapier', 'we use Zapiar and Zapiaar').text, 'we use Zapier and Zapiaar'); // 6 letters: distance 1 only
  assert.equal(fix('Notionx', 'Notionxyz').text, 'Notionxyz'); // 7 letters: 2 away is too far
});

test('fuzzy: terms shorter than 5 letters are never fuzzy matched', () => {
  assert.equal(fix('Zoe', 'Zoa joined').text, 'Zoa joined');
  assert.equal(fix('AWS', 'we use Aws today and Axs').text, 'we use AWS today and Axs'); // exact (case) only, not fuzzy
});

test('fuzzy: whole words only, so a longer word that merely contains the term is never touched', () => {
  assert.equal(fix('CapCut', 'Capcutting and recapcut').text, 'Capcutting and recapcut'); // 3 and 2 edits away
  // A trailing letter is ONE edit, so a plural is within the rule and becomes the term (the plural "s" is lost).
  assert.equal(fix('CapCut', 'Capcuts').text, 'CapCut');
});

test('fuzzy: a word that is an ordinary English word is NEVER changed by fuzzy matching', () => {
  // each of these ordinary words is within distance 1 of the term, and must stay as it is
  for (const [term, word] of [['Sarah', 'Sara'], ['Figma', 'sigma'], ['Shopify', 'shopping'], ['Brand', 'bland'], ['Grain', 'train'], ['Stripe', 'strip'], ['Slack', 'black'], ['Linear', 'lineal']]) {
    assert.ok(common.has(word.toLowerCase()), `test setup: "${word}" should be an ordinary word`);
    const r = fix(term, `we said ${word} twice`);
    assert.equal(r.text, `we said ${word} twice`, `${word} must not become ${term}`);
    assert.deepEqual(r.changes, []);
  }
});

test('fuzzy: when two terms are equally close the word is left alone; an exact term beats a close one', () => {
  assert.equal(fix('Zapier, Zapied', 'we use Zapiem here').text, 'we use Zapiem here'); // both 1 away
  assert.equal(fix('Zapier, Zapiem', 'we use Zapiem here').text, 'we use Zapiem here'); // exact for Zapiem: nothing to change
  assert.equal(fix('Zapier, Zapiem', 'we use Zapiex here').text, 'we use Zapiex here'); // 1 from both: ambiguous
});

test('fuzzy: possessives, punctuation and numbers', () => {
  assert.equal(fix('CapCut', "Capcat's new release, Capcat.").text, "CapCut's new release, CapCut.");
  assert.equal(fix('CapCut', 'version 2024 and 12345').text, 'version 2024 and 12345');
});

// ---------- case ----------

test('case: the right word with the wrong capitalisation is fixed, and the original capitalisation pattern is kept', () => {
  assert.equal(fix('LiteCut', 'we love litecut and Litecut').text, 'we love LiteCut and LiteCut'); // mixed-capital term: the glossary spelling
  assert.equal(fix('LiteCut', 'we love LITECUT').text, 'we love LITECUT'); // ALL CAPS stays upper case
  assert.equal(fix('Shopify', 'we use shopify and SHOPIFY').text, 'we use shopify and SHOPIFY'); // ordinary-looking term: pattern kept
  assert.equal(fix('Shopify', 'we use Shopfy').text, 'we use Shopify'); // Title case in, Title case out
  assert.equal(fix('Shopify', 'we use shopfy').text, 'we use shopify'); // lower case in, lower case out
  assert.equal(fix('Shopify', 'we use SHOPFY').text, 'we use SHOPIFY');
  const r = fix('LiteCut', 'litecut');
  assert.deepEqual(r.changes.map((c) => c.kind), ['case']);
});

test('case: a glossary term that is an ordinary word (Notion, Slack, Teams) is left alone', () => {
  for (const term of ['Notion', 'Slack', 'Teams', 'Zoom']) {
    assert.ok(common.has(term.toLowerCase()), `${term} should be an ordinary word`);
    const lower = term.toLowerCase();
    assert.equal(fix(term, `the ${lower} of it`).text, `the ${lower} of it`);
  }
});

test('applyCase unit: patterns', () => {
  assert.equal(applyCase('vibe', 'Vibe'), 'vibe');
  assert.equal(applyCase('Vibe', 'vibe'), 'Vibe');
  assert.equal(applyCase('VIBE', 'vibe'), 'VIBE');
  assert.equal(applyCase('x', 'LiteCut'), 'LiteCut');
  assert.equal(applyCase('A', 'Zoe'), 'Zoe'); // a single capital letter is not "all caps": it is Title case
});

// ---------- the record ----------

test('every replacement is recorded with the original, the replacement and the timestamp', () => {
  const r = fix('LiteCut=Lite Cut, CapCut', 'Lite Cut and Capcat and capcut', 99.25);
  assert.deepEqual(r.changes, [
    { from: 'Lite Cut', to: 'LiteCut', t: 99.25, kind: 'listed' },
    { from: 'Capcat', to: 'CapCut', t: 99.25, kind: 'fuzzy' },
    { from: 'capcut', to: 'CapCut', t: 99.25, kind: 'case' },
  ]);
  assert.equal(r.text, 'LiteCut and CapCut and CapCut');
  assert.deepEqual(fix('CapCut', 'nothing to fix here').changes, []);
});

test('no glossary means no change and no cost; weird input never throws', () => {
  for (const g of ['', null, undefined, ' , ;']) {
    const f = createGlossaryFixer(g);
    assert.equal(f.enabled, false);
    assert.deepEqual(f.fix('Lite Cut stays'), { text: 'Lite Cut stays', changes: [] });
  }
  const f = fixer('CapCut');
  for (const bad of [undefined, null, '', 12345, '   ']) assert.doesNotThrow(() => f.fix(bad));
  assert.equal(f.fix('Привет Capcat 你好').text, 'Привет CapCut 你好'); // other scripts pass through untouched
});

test('the corrected text is the only thing returned: the original words never appear in it', () => {
  const r = fix('LiteCut=Lite Cut', 'we like Lite Cut a lot');
  assert.ok(!r.text.includes('Lite Cut'));
});

test('speed: a 2-hour meeting of words with a 20-term glossary is processed quickly', () => {
  const f = fixer(Array.from({ length: 20 }, (_, i) => `Termname${i}x`).join(', '));
  const words = 'the quick brown fox jumps over the lazy dog while we talk about the budget and the launch plan'.split(' ');
  const line = Array.from({ length: 15 }, (_, i) => words[i % words.length]).join(' ');
  const t0 = Date.now();
  for (let i = 0; i < 6000; i++) f.fix(line); // about 90,000 words
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
