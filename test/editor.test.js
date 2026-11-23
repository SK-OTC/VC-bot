// The /admin editor's converter (src/editor-core.js): what the page shows must come back as the same text, and what browsers
// produce while editing (b/i/strike tags, styled spans, nested lists, divs, line breaks) must turn into the notes' format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOM_TO_TEXT_SOURCE } from '../src/editor-core.js';

// The converter is stored as source text (so bundling cannot change the page script); here it is turned into a function.
const domToText = new Function(`${DOM_TO_TEXT_SOURCE}
return domToText;`)();
import { renderNote } from '../src/share-page.js';

// ---------- a tiny HTML parser that builds the few DOM properties domToText uses ----------

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const textNode = (value) => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
const element = (name, attrs) => ({ nodeType: 1, nodeName: name.toUpperCase(), childNodes: [], getAttribute: (a) => (a in attrs ? attrs[a] : null) });

function parse(html) {
  const root = element('div', {});
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[3] !== undefined) {
      top.childNodes.push(textNode(decode(m[3])));
      continue;
    }
    const name = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      while (stack.length > 1 && stack.pop().nodeName !== name.toUpperCase());
      continue;
    }
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '');
    const el = element(name, attrs);
    top.childNodes.push(el);
    if (!VOID.has(name) && !m[0].endsWith('/>')) stack.push(el);
  }
  return root;
}
const toText = (html) => domToText(parse(html));
const roundTrip = (text) => toText(renderNote(text));

// ---------- the page shows it, the editor gives the same text back ----------

test('round trip: every format the notes use comes back exactly', () => {
  const samples = [
    // a generated summary
    'Sprint 2 planning\n\n**Pre-processing**\n- Enforce 30 FPS with FFprobe\n  - Alisha to confirm ownership\n      - by Friday 27 November\n- HDR to SDR for older devices\n\n**Next steps**\n- Lena: review the PR today [00:34:18]\n- Omar: audio mixing by Friday 27 November [00:32:12] (unverified)\n\nSummary written by Gemma 4 26B-A4B on Cloudflare Workers AI.',
    // every mark and block the editor offers
    'Title line\n\n**Topic**\n- **bold** and *italic* and __underline__ and ~~struck~~ text\n- ***bold italic*** and __**underlined bold**__\n\n1. first\n2. second\n  1. nested one\n  2. nested two\n3. third\n\n> a quote with *style*\n-# small print\nA closing paragraph.',
    // characters that must stay text
    'Notes with <script>alert(1)</script> & "quotes" and \'apostrophes\'\n- 2 * 3 * 4 = 24\n- file_name__v2 and a lone ~ tilde',
  ];
  for (const text of samples) assert.equal(roundTrip(text), text, text.slice(0, 40));
});

test('round trip is stable: converting twice changes nothing more', () => {
  const messy = '**A**\n-   spaced bullet\n* star bullet\n## Hash heading\n\n\n\nparagraph';
  const once = roundTrip(messy);
  assert.equal(roundTrip(once), once);
  assert.equal(once, '**A**\n- spaced bullet\n- star bullet\n\n**Hash heading**\nparagraph');
});

// ---------- what browsers produce while editing ----------

test('browser markup: b/i/strike/del tags and styled spans become marks; doubled tags never double the marks', () => {
  assert.equal(toText('<p><b>bold</b> <i>it</i> <strike>gone</strike> <del>del</del> <u>under</u></p>'), '**bold** *it* ~~gone~~ ~~del~~ __under__');
  assert.equal(toText('<p><span style="font-weight: 700;">heavy</span> <span style="font-style: italic;">slanted</span> <span style="text-decoration-line: underline;">line</span> <span style="text-decoration: line-through;">x</span></p>'), '**heavy** *slanted* __line__ ~~x~~');
  assert.equal(toText('<p><b><b>twice</b></b> <strong><b>again</b></strong></p>'), '**twice** **again**');
  assert.equal(toText('<p><b> spaced </b>word</p>'), ' **spaced** word'.trim(), 'spaces move outside the marks');
  assert.equal(toText('<p><b></b>empty<i> </i>marks</p>'), 'empty marks');
});

test('browser markup: divs, line breaks, nested lists, headings and quotes', () => {
  assert.equal(toText('<div>one</div><div>two<br>three</div>'), 'one\ntwo\nthree');
  assert.equal(toText('<ul><li>a<ul><li>b<ul><li>c<ul><li>too deep</li></ul></li></ul></li></ul></li></ul>'), '- a\n  - b\n      - c\n      - too deep', 'nested lists, never deeper than level 2');
  assert.equal(toText('<ul><li>a</li><ul><li>Chrome puts the sub-list here</li></ul></ul>'), '- a\n  - Chrome puts the sub-list here');
  assert.equal(toText('<ol><li>a</li><li class="d1">b</li><li class="d1">c</li><li>d</li></ol>'), '1. a\n  1. b\n  2. c\n2. d');
  assert.equal(toText('<h1>Big <b>title</b></h1><h3>small</h3>'), '**Big title**\n\n**small**', 'any heading level, marks dropped (a heading is "**text**")');
  assert.equal(toText('<h2><span class="hash">#</span>Topic</h2>'), '**Topic**', 'the decorative # is not text');
  assert.equal(toText('<blockquote><p>one</p><p>two</p></blockquote><blockquote>a<br>b</blockquote>'), '> one\n> two\n> a\n> b');
  assert.equal(toText('<p class="sub">fine <i>print</i></p>'), '-# fine *print*');
  assert.equal(toText('<ul><li><br></li><li>kept</li></ul><p><br></p><p>&nbsp;</p>'), '- kept', 'empty items and paragraphs are dropped');
  assert.equal(toText('loose text<p>para</p>'), 'loose text\npara');
});

test('numbered lists keep their numbers: a list interrupted by a paragraph continues, and a copied value never repeats a number', () => {
  const interrupted = '1. Intro\n2. Budget\n\nSome note\n3. Hiring\n4. Close';
  assert.equal(roundTrip(interrupted), interrupted);
  // Enter in a browser copies value="2" onto the new item: the run is counted on from its first number
  assert.equal(toText('<ol><li value="2">b</li><li value="2">new</li><li value="3">c</li></ol>'), '2. b\n3. new\n4. c');
  assert.equal(toText('<ol><li value="0">zero is not a start</li><li>x</li></ol>'), '1. zero is not a start\n2. x');
  assert.equal(toText('<ol><li value="5">a</li><li class="d1" value="9">nested starts at its own number</li></ol>'), '5. a\n  9. nested starts at its own number');
});
