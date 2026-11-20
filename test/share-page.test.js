import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderNote, transcriptPage, notFoundPage, esc, SECURITY_HEADERS } from '../src/share-page.js';
import { CHAT_SCRIPT, CHAT_SCRIPT_HASH } from '../src/chat-script.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const base = { started_at: NOW, duration_sec: 3725, expires_at: NOW + 86_400, speakers: JSON.stringify([{ name: 'Alice' }, { name: 'Sam' }]) };

test('renderNote: headings, bullets, nesting, paragraphs and the byline', () => {
  const html = renderNote(['**Summary**', '- first point [00:01:02]', '  - nested point', '      - deeper point', '- back out', '', 'A plain paragraph.', '', '**Action items**', '- Alice: send it [00:10:20] (unverified)', '', 'Summary written by Llama 3.3 70B on Cloudflare Workers AI.'].join('\n'));
  assert.match(html, /<h2><span class="hash" aria-hidden="true">#<\/span>Summary<\/h2><ul>/);
  assert.match(html, /<li class="d0">first point <span class="ts">\[00:01:02\]<\/span><\/li>/);
  assert.match(html, /<li class="d1">nested point<\/li>/);
  assert.match(html, /<li class="d2">deeper point<\/li>/);
  assert.match(html, /<li class="d0">back out<\/li><\/ul><p>A plain paragraph\.<\/p>/);
  assert.match(html, /<h2><span class="hash" aria-hidden="true">#<\/span>Action items<\/h2>/);
  assert.match(html, /<span class="unv">\(unverified\)<\/span>/);
  assert.match(html, /<p class="byline">Summary written by Llama 3\.3 70B on Cloudflare Workers AI\.<\/p>$/);
  // every list that was opened is closed
  assert.equal((html.match(/<ul>/g) ?? []).length, (html.match(/<\/ul>/g) ?? []).length);
});

test('renderNote: a line with two bold spans is text, not a heading; bold and unbalanced stars are safe', () => {
  assert.match(renderNote('**One** and **two**'), /^<p><strong>One<\/strong> and <strong>two<\/strong><\/p>$/);
  assert.match(renderNote('**Only a heading**'), /^<h2>/);
  assert.match(renderNote('**Heading with colon:**'), /<h2><span class="hash" aria-hidden="true">#<\/span>Heading with colon:<\/h2>/);
  assert.match(renderNote('- a **bold** bullet'), /<li class="d0">a <strong>bold<\/strong> bullet<\/li>/);
  assert.equal(renderNote('stray ** stars'), '<p>stray ** stars</p>');
  assert.equal(renderNote(''), '');
  assert.equal(renderNote(null), '');
  assert.equal(renderNote('   \n\n  '), '');
});

test('renderNote: everything from outside is escaped, in headings, bullets, paragraphs and the byline', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = renderNote([`**${evil}**`, `- ${evil}`, `  - **${evil}** [00:00:01]`, evil, `Summary written by ${evil}`].join('\n'));
  assert.ok(!html.includes('<script') && !html.includes('<img'));
  assert.equal((html.match(/&lt;script&gt;/g) ?? []).length, 5);
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]));
  for (const tag of tags) assert.ok(['h2', 'span', 'ul', 'li', 'p', 'strong'].includes(tag), `unexpected <${tag}>`);
});

test('page: the note column has the title, a people chip, a date chip, then the sections; no duration, no transcript', () => {
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- a point [00:00:05]\n\n**Action items**\n- Sam: do it [00:00:09]', actions_text: '- Sam: do it [00:00:09]', transcript_text: 'SECRET TRANSCRIPT WORDS' });
  assert.match(html, /<h1>Meeting summary<\/h1><div class="chips"><span class="chip"><svg[^>]*>.*?<\/svg>Alice, Sam<\/span><span class="chip"><svg[^>]*>.*?<\/svg>Nov 19<\/span><\/div>/);
  assert.ok(!html.includes('SECRET TRANSCRIPT WORDS'));
  assert.ok(!html.includes('01:02:05'), 'the length is not shown');
  // action items already in the summary are not repeated from actions_text
  assert.equal((html.match(/Sam: do it/g) ?? []).length, 1);
});

test('page: action items are added from actions_text only when the summary has no such section', () => {
  const without = transcriptPage({ ...base, summary_text: '**Summary**\n- a point', actions_text: '- Sam: do it [00:00:09]' });
  assert.match(without, /Action items<\/h2><ul><li class="d0">Sam: do it/);
  const nothing = transcriptPage({ ...base, summary_text: null, actions_text: null });
  assert.match(nothing, /No summary is available for this meeting\./);
});

test('page: it is dark, has the top bar without any sign-in, and uses no outside name, logo or font', () => {
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- x' }, { enabled: true, maxChars: 500 });
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /color-scheme:dark/);
  assert.match(html, /<header class="top"><span class="brand">VC Bot<\/span><\/header>/);
  assert.ok(!/sign.?in|log.?in|granola/i.test(html), 'no sign-in and no other product name');
  assert.ok(!/<img|url\(|@import|@font-face|https?:\/\//i.test(html), 'no images, no outside files, no addresses');
  assert.ok(!/<a[\s>]|<iframe|<link/i.test(html));
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'no script is loaded from anywhere');
});

test('page: the single script is the one the CSP allows by hash; a page without questions has no script at all', () => {
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- x' }, { enabled: true, maxChars: 500 });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'exactly one script tag');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1], CHAT_SCRIPT);
  const hash = 'sha256-' + createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
  assert.equal(CHAT_SCRIPT_HASH, hash, `CHAT_SCRIPT_HASH is out of date: it should be '${hash}'`);
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, new RegExp(`script-src '${hash.replace(/[+/=]/g, '\\$&')}'(;|$)`));
  assert.ok(!/unsafe-inline[^;]*script|script-src[^;]*unsafe/.test(csp), 'no unsafe-inline for scripts');
  assert.match(csp, /connect-src 'self'/);
  assert.ok(!/<script/i.test(transcriptPage({ ...base, summary_text: 'x' }, { enabled: false })));
  assert.ok(!/<script/i.test(notFoundPage()));
});

test('script: Enter sends, Shift+Enter is left alone, results go in with textContent, nothing is written with innerHTML', () => {
  assert.match(CHAT_SCRIPT, /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.isComposing/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(CHAT_SCRIPT));
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(CHAT_SCRIPT));
  assert.ok(!/\\/.test(CHAT_SCRIPT), 'no backslashes: the template literal text and the browser text must be identical');
});

test('page: no square focus box on the question box; the smooth and loading styles are there', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(transcriptPage({ ...base, summary_text: 'x' }, { enabled: true }))[1];
  assert.match(css, /textarea:focus-visible\{outline:none\}/);
  assert.match(css, /\.ask:focus-within\{border-color:/, 'the rounded border still shows focus');
  assert.match(css, /\.loading span\{[^}]*animation:pulse/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
});

test('page: the question panel has the box, the send button and exactly two suggestion buttons, all plain forms', () => {
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- x' }, { enabled: true, maxChars: 500 });
  assert.match(html, /<aside class="chat" aria-label="Ask about the meeting">/);
  assert.match(html, /<textarea id="q" name="q" rows="1" maxlength="500" required placeholder="Ask about the meeting\.\.\.">/);
  assert.match(html, /<button class="send" type="submit" aria-label="Ask">/);
  assert.match(html, /<label class="sr" for="q">Ask about the meeting<\/label>/);
  const chips = [...html.matchAll(/<button class="suggest" type="submit" name="q" value="([^"]+)">.*?<\/span>([^<]+)<\/button>/g)];
  assert.deepEqual(chips.map((m) => [m[2], m[1]]), [['Write tldr', 'Write a tldr of this meeting.'], ['List action items', 'List the action items from this meeting.']]);
  assert.equal((html.match(/<form/g) ?? []).length, 3);
  assert.ok(!/<form[^>]*action=/i.test(html), 'forms post back to the same address');
});

test('page: with questions off there is no panel at all and the note is centred on its own', () => {
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- x' }, { enabled: false });
  assert.ok(!/<aside|<textarea|<form/.test(html));
  assert.match(html, /<div class="layout solo">/);
});

test('page: the question and answer appear in the panel, the answer is marked up safely, errors are our own text', () => {
  const evil = '<script>alert(1)</script>';
  const html = transcriptPage({ ...base, summary_text: '**Summary**\n- x' }, { enabled: true, maxChars: 500, question: `what ${evil}?`, answer: `**Short** answer ${evil} [00:02:00]\n- one\n- two (unverified)` });
  assert.match(html, /<p class="q">what &lt;script&gt;alert\(1\)&lt;\/script&gt;\?<\/p>/);
  assert.match(html, /<div class="a"><p><strong>Short<\/strong> answer &lt;script&gt;alert\(1\)&lt;\/script&gt; <span class="ts">\[00:02:00\]<\/span><\/p><ul><li class="d0">one<\/li>/);
  assert.ok(!html.includes('<script>alert') && (html.match(/<script/g) ?? []).length === 1, 'only our own script, never the answer text');
  assert.match(html, /can be wrong/);
  const err = transcriptPage({ ...base, summary_text: 'x' }, { enabled: true, maxChars: 500, question: 'my question', error: 'Q&A is paused until midnight UTC.' });
  assert.match(err, /<p class="err">Q&amp;A is paused until midnight UTC\.<\/p>/);
  assert.match(err, />my question<\/textarea>/, 'the question comes back into the box after an error');
  assert.ok(!/class="q"/.test(err));
});

test('page: the expiry notice is always there, and speakers with odd data never break it', () => {
  assert.match(transcriptPage({ ...base, summary_text: 'x' }), /Private link\. Anyone who has this address can read this page until 2026-11-20\. Please do not share it outside your team\./);
  assert.match(transcriptPage({ ...base, summary_text: 'x' }, { enabled: true }), /read this page and ask questions about the meeting until 2026-11-20/);
  for (const speakers of ['not json{', '"text"', '{}', '[{"x":1}]', '[]', null, undefined]) {
    const html = transcriptPage({ ...base, speakers, summary_text: 'x' });
    assert.ok(html.includes('<h1>Meeting summary</h1>'));
    assert.ok(!html.includes('Alice'));
  }
  assert.match(transcriptPage({ ...base, speakers: '[]', summary_text: 'x' }), /<div class="chips"><span class="chip"><svg[^>]*>.*?<\/svg>Nov 19<\/span><\/div>/, 'no people chip without speakers');
});

test('page: a narrow screen stacks the panel under the note, and the colours pass AA contrast', () => {
  const html = transcriptPage({ ...base, summary_text: 'x' }, { enabled: true });
  assert.match(html, /@media \(max-width:900px\)\{\s*\.layout\{display:block\}/);
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const v = (name) => new RegExp(`--${name}:(#[0-9a-f]{6})`).exec(css)[1];
  const lin = (hex) => { const x = parseInt(hex, 16) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const L = (hex) => 0.2126 * lin(hex.slice(1, 3)) + 0.7152 * lin(hex.slice(3, 5)) + 0.0722 * lin(hex.slice(5, 7));
  const ratio = (a, b) => (Math.max(L(a), L(b)) + 0.05) / (Math.min(L(a), L(b)) + 0.05);
  for (const [fg, bg] of [['text', 'bg'], ['text', 'panel'], ['title', 'bg'], ['chip-text', 'bg'], ['placeholder', 'panel'], ['suggest', 'panel'], ['err', 'panel']]) {
    assert.ok(ratio(v(fg), v(bg)) >= 4.5, `--${fg} on --${bg} is only ${ratio(v(fg), v(bg)).toFixed(2)}:1`);
  }
});

test('not found page: same dark shell, one plain message, nothing about why', () => {
  const html = notFoundPage();
  assert.match(html, /<header class="top"><span class="brand">VC Bot<\/span><\/header>/);
  assert.match(html, /This link is not available/);
  assert.ok(!/<form|<textarea|<aside/.test(html));
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});

test('page: the top bar stays pinned while scrolling (sticky, above the content, opaque), and the question panel sits just under it', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(transcriptPage({ ...base, summary_text: 'x' }, { enabled: true }))[1];
  const top = /\.top\{([^}]*)\}/.exec(css)[1];
  assert.match(top, /position:sticky/);
  assert.match(top, /top:0/);
  assert.match(top, /z-index:\d+/);
  assert.match(top, /background:var\(--bg\)/, 'opaque, so text scrolling underneath is hidden');
  const barHeight = Number(/height:(\d+)px/.exec(top)[1]);
  assert.ok(/\.chat\{([^}]*)\}/.exec(css)[1].includes(`position:sticky;top:${barHeight}px;height:calc(100vh - ${barHeight}px)`));
});
