// The read-only web page behind a share link, and the strict headers every response from /t/ carries.
// Security rules for this file:
//  * Every piece of text that came from speech, a Discord name, a language model or a reader is HTML-escaped first.
//  * The page has no images and no links. Its only forms post back to the same address (CSP form-action 'self'). The one
//    scripts (src/chat-script.js on the reader page when questions are on, src/editor-script.js on /admin) are allowed by their
//    hashes alone, and without them every page still works (plain forms).
//  * The transcript itself is never put on the page: readers get the summary and can ask questions about the meeting.
//  * The only markup that is not escaped text is what this file writes itself: tags, a few fixed icons, and the three
//    inline marks made by `inline()` below, which wrap text that has already been escaped.
//
// Design: a dark page laid out like the note view in the screenshot the owner supplied (a centred note column, a right-hand
// panel with the question box, a top bar with no sign-in). The screenshot is Granola's LIGHT mode, so the light values below were
// sampled from its pixels and the dark ones DERIVED from them: each light colour has its lightness mirrored in OKLab
// (L' = 0.20 + 0.75 x (1 - L), hue and chroma kept), and any small text under 4.5:1 contrast was lifted until it passed.
// These are not Granola's own dark colours (they are not visible in the screenshot); change the variables to adjust.
// Granola's name, logo and fonts are not used.

import { CHAT_SCRIPT, CHAT_SCRIPT_HASH } from './chat-script.js';
import { EDITOR_SCRIPT, EDITOR_SCRIPT_HASH } from './editor-script.js';

export const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Scripts only by hash (chat-script.js and editor-script.js); fetch only to this same address (answers and saves are fetched
  // without a reload).
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src '${CHAT_SCRIPT_HASH}' '${EDITOR_SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escaped text with its marks made visible. Escaping happens FIRST, so the output can only contain the tags written here.
 * The marks are Discord's (so the same text also reads right in Discord): **bold** -> <strong>, *italic* -> <em>,
 * __underline__ -> <u>, ~~strikethrough~~ -> <s>; plus [hh:mm:ss] -> a muted timestamp and (unverified) -> an italic mark.
 */
export function inline(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2}:\d{2}:\d{2})\]/g, '<span class="ts">[$1]</span>')
    .replace(/\(unverified\)/g, '<span class="unv">(unverified)</span>');
}

// The kinds of line the notes are made of (the same text format the model writes and the /admin editor saves).
const LINE_HEADING = /^\s*\*\*([^*]+)\*\*:?\s*$/; // a line that is ONLY one bold phrase; two bold spans are ordinary text
const LINE_HASH_HEADING = /^\s*#{1,3}\s+(.+)$/; // "## Heading"
const LINE_SUBTEXT = /^\s*-#\s+(.*)$/; // Discord's subtext: "-# small print"
const LINE_QUOTE = /^\s*>\s?(.*)$/; // "> a quote"
const LINE_NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/; // "1. step"
const LINE_BULLET = /^(\s*)[-*•]\s+(.*)$/; // "- point", indented by 2 (or 6) spaces for a sub-point

/** How deep a list item is: 2+ spaces of indent is level 1, 6+ is level 2 (the format the model has always written). */
export const listDepth = (indent) => {
  const n = indent.replace(/\t/g, '  ').length;
  return n >= 6 ? 2 : n >= 2 ? 1 : 0;
};

/**
 * The notes as headings, bullet and numbered lists, quotes, subtext and paragraphs. List items indented by 2+ spaces are nested
 * (up to two levels). A final line "Summary written by ..." becomes a quiet byline.
 * opts.changed: a Set of line numbers (0-based) whose block gets class "chg" (the AI edit preview highlights changed lines).
 */
export function renderNote(text, { changed = null } = {}) {
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (kind) => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const chg = changed?.has(i) ? ' chg' : '';
    const cls = (base) => (base || chg ? ` class="${(base + chg).trim()}"` : '');
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = LINE_HEADING.exec(line) ?? LINE_HASH_HEADING.exec(line);
    if (heading) {
      closeList();
      out.push(`<h2${cls('')}><span class="hash" aria-hidden="true">#</span>${inline(heading[1].trim())}</h2>`);
      continue;
    }
    const sub = LINE_SUBTEXT.exec(line);
    if (sub) {
      closeList();
      out.push(`<p${cls('sub')}>${inline(sub[1])}</p>`);
      continue;
    }
    const quote = LINE_QUOTE.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote${cls('')}>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const numbered = LINE_NUMBERED.exec(line);
    if (numbered) {
      openList('ol');
      out.push(`<li${cls(`d${listDepth(numbered[1])}`)} value="${Number(numbered[2])}">${inline(numbered[3])}</li>`);
      continue;
    }
    const bullet = LINE_BULLET.exec(line);
    if (bullet) {
      openList('ul');
      out.push(`<li${cls(`d${listDepth(bullet[1])}`)}>${inline(bullet[2])}</li>`);
      continue;
    }
    closeList();
    out.push(/^Summary written by /.test(line.trim()) ? `<p${cls('byline')}>${esc(line.trim())}</p>` : `<p${cls('')}>${inline(line.trim())}</p>`);
  }
  closeList();
  return out.join('');
}

const hhmm = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
export { hhmm };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (sec) => {
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const utcDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

const ICON = (inner) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const PEOPLE = ICON('<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.3-2.3 2-3.5 4.2-3.5s3.9 1.2 4.2 3.5"/><circle cx="11.5" cy="6.2" r="1.7"/><path d="M11.2 9.7c1.8 0 3 .9 3.3 2.8"/>');
const CALENDAR = ICON('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4"/>');
const ARROW_UP = ICON('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>').replace('width="14" height="14"', 'width="16" height="16"');

const CSS = `
:root{color-scheme:dark;--bg:#1b1b17;--panel:#161616;--line:#282824;--chip-line:#23231e;--text:#83837f;--title:#eeeeee;--hash:#32332f;--chip-text:#818481;--input-line:#262626;--placeholder:#818382;--send:#21211e;--suggest:#808386;--err:#ff8787;--ok:#8fd19e}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.top{position:sticky;top:0;z-index:20;height:50px;display:flex;align-items:center;padding:0 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{font-size:1.15rem;font-weight:650;letter-spacing:-.01em;color:var(--title);text-decoration:none}
.brand:hover,.brand:focus-visible{text-decoration:underline}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 383px;min-height:calc(100vh - 50px)}
.layout.solo{grid-template-columns:minmax(0,1fr)}
.note{padding:4.2rem 24px 5rem}
.article{max-width:600px;margin:0 auto}
h1{font:400 2.15rem/1.18 Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif;color:var(--title);margin:0 0 1rem;letter-spacing:-.01em}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.6rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--chip-text)}
.dot.good{background:var(--ok)}
.dot.bad{background:var(--err)}
.status{list-style:none;padding:0;margin:.3rem 0 .6rem}
.status li{display:flex;align-items:center;gap:.65rem;margin:0;padding:.6rem 0;border-bottom:1px solid var(--line)}
.status .state{margin-left:auto;color:var(--title);font-size:.85rem}
.chip{display:inline-flex;align-items:center;gap:.4rem;border:1px solid var(--chip-line);border-radius:999px;padding:.22rem .7rem;font-size:.8rem;line-height:1.4;color:var(--chip-text)}
h2{position:relative;font-size:.95rem;font-weight:600;color:var(--text);margin:1.5rem 0 .45rem}
.hash{position:absolute;left:-1.15rem;font-weight:400;color:var(--hash)}
ul{margin:.15rem 0 .3rem;padding-left:1.05rem}
li{margin:.3rem 0;color:var(--text)}
li.d1{margin-left:1.1rem;list-style-type:circle}
li.d2{margin-left:2.2rem;list-style-type:square}
p{margin:.5rem 0}
code{white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;color:var(--title);background:var(--send);border-radius:4px;padding:.05rem .3rem}
.article a{color:var(--title)}
strong{font-weight:600}
.ts{font-variant-numeric:tabular-nums;opacity:.72}
.unv{font-style:italic;opacity:.8}
.byline,.fine{font-size:.8rem;color:var(--chip-text)}
.byline{margin-top:1.6rem}
.fine{margin-top:2.2rem}
.chat{background:var(--panel);border-left:1px solid var(--line);position:sticky;top:50px;height:calc(100vh - 50px);display:flex;flex-direction:column}
.thread{flex:1;overflow-y:auto;padding:1.25rem 1.25rem .5rem}
.thread{scroll-behavior:smooth}
.thread>*{animation:rise .28s ease-out both}
.q{margin:.9rem 0 .7rem auto;width:fit-content;max-width:92%;background:var(--send);color:var(--title);font-size:.88rem;line-height:1.45;padding:.5rem .85rem;border-radius:14px 14px 4px 14px;overflow-wrap:anywhere}
.a{margin:0 0 .5rem}
.a p,.a li{color:var(--text)}
.a h2{margin-top:1rem}
.err{color:var(--err);font-size:.9rem}
.loading{display:flex;gap:.35rem;align-items:center;height:1.6rem;margin:.3rem 0 .6rem .2rem}
.loading span{width:7px;height:7px;border-radius:50%;background:var(--chip-text);animation:pulse 1.2s ease-in-out infinite}
.loading span:nth-child(2){animation-delay:.18s}
.loading span:nth-child(3){animation-delay:.36s}
@keyframes pulse{0%,70%,100%{opacity:.25;transform:translateY(0) scale(.85)}35%{opacity:1;transform:translateY(-3px) scale(1)}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.composer{padding:.5rem 1.1rem 1.1rem}
.chips-row{display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin:0 0 .8rem .3rem}
.chips-row form{margin:0}
.suggest{display:inline-flex;align-items:center;gap:.4rem;background:none;border:0;padding:.1rem 0;font:inherit;font-size:.78rem;color:var(--suggest);cursor:pointer;transition:color .15s ease}
.suggest:hover{color:var(--title)}
.slash{display:inline-grid;place-items:center;width:.95rem;height:.95rem;border:1px solid var(--chip-line);border-radius:3px;font-size:.62rem;line-height:1}
.ask{display:flex;align-items:center;gap:.5rem;border:1px solid var(--input-line);border-radius:999px;background:var(--panel);padding:.35rem .4rem .35rem 1rem;transition:border-color .18s ease,box-shadow .18s ease}
textarea{flex:1;min-width:0;border:0;outline:0;resize:none;background:transparent;color:var(--title);font:inherit;font-size:.9rem;line-height:1.4;padding:.35rem 0;max-height:7rem;field-sizing:content}
textarea::placeholder{color:var(--placeholder);opacity:1}
.send{flex:none;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--send);color:var(--placeholder);cursor:pointer;transition:background-color .18s ease,color .18s ease,transform .12s ease,opacity .18s ease}
.send:hover{color:var(--title)}
.send:active{transform:scale(.92)}
.ask:has(textarea:not(:placeholder-shown)) .send{background:var(--title);color:var(--bg)}
.busy .send{opacity:.45;cursor:default}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:2px solid var(--title);outline-offset:2px}
textarea:focus-visible{outline:none}
.ask:focus-within{border-color:var(--chip-text)}
@media (prefers-reduced-motion:reduce){
  .thread{scroll-behavior:auto}
  .thread>*{animation:none}
  .loading span{animation:none;opacity:.6}
  .ask,.send,.suggest{transition:none}
}
.edit textarea{display:block;width:100%;min-height:18rem;max-height:none;field-sizing:fixed;border:1px solid var(--input-line);border-radius:12px;background:var(--panel);padding:.8rem 1rem;font-size:.9rem;line-height:1.5;color:var(--title);resize:vertical;transition:border-color .18s ease}
.edit textarea:focus,.edit textarea:focus-visible{border-color:var(--chip-text);outline:none}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;margin:.8rem 0}
.btn{font:inherit;font-size:.85rem;border-radius:999px;padding:.45rem 1.1rem;border:1px solid var(--input-line);background:var(--send);color:var(--title);cursor:pointer;transition:background-color .18s ease,color .18s ease,transform .12s ease}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--title);color:var(--bg);border-color:var(--title)}
.ok{color:var(--ok);font-size:.9rem}
blockquote{margin:.5rem 0;padding:.05rem 0 .05rem .85rem;border-left:3px solid var(--chip-line)}
p.sub{font-size:.8rem;color:var(--chip-text)}
ol{margin:.15rem 0 .3rem;padding-left:1.35rem}
ol li.d1{margin-left:1.1rem;list-style-type:lower-alpha}
ol li.d2{margin-left:2.2rem;list-style-type:lower-roman}
em{font-style:italic}
.chg{background:rgba(143,209,158,.12);box-shadow:-.5rem 0 0 rgba(143,209,158,.55);border-radius:3px}
.notes.editing{outline:none;caret-color:var(--title);min-height:6rem}
.notes.editing:focus{outline:none}
.notes.previewing{opacity:.95;cursor:default}
.editbar{display:flex;justify-content:flex-end;min-height:1.2rem;margin:-2.4rem 0 1.2rem}
.save{font-size:.78rem;color:var(--chip-text)}
.save.bad{color:var(--err)}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:.6rem .8rem;margin:0 0 1.2rem;font-size:.85rem;color:var(--title)}
.bar .msg{flex:1 1 14rem}
.toolbar{position:fixed;z-index:40;display:flex;gap:2px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:0 6px 24px rgba(0,0,0,.45)}
.toolbar button{min-width:30px;height:30px;padding:0 .45rem;border:0;border-radius:7px;background:transparent;color:var(--text);font:inherit;font-size:.85rem;cursor:pointer}
.toolbar button:hover,.toolbar button[aria-pressed="true"]{background:var(--send);color:var(--title)}
.toolbar .sep{width:1px;margin:4px 3px;background:var(--line)}
[hidden]{display:none!important}
.layout:has(>.chat[hidden]){grid-template-columns:minmax(0,1fr)}
.missing{max-width:30rem;margin:18vh auto 0;padding:0 24px}
.missing h1{font-size:1.8rem}
@media (max-width:900px){
  .layout{display:block}
  .note{padding:2.2rem 18px 2rem}
  .hash{display:none}
  .chat{position:static;height:auto;border-left:0;border-top:1px solid var(--line)}
  .thread{overflow:visible}
}`;

/** The page frame. Meeting pages are never indexed; the public privacy page passes { indexable: true }. */
export function shell(title, bodyHtml, { indexable = false } = {}) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (indexable ? '' : '<meta name="robots" content="noindex,nofollow,noarchive">') + '<meta name="referrer" content="no-referrer">' +
    '<meta name="color-scheme" content="dark">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<header class="top"><a class="brand" href="/">VC Bot</a></header>${bodyHtml}</body></html>`
  );
}

/** The same page for a wrong, expired, revoked or malformed link, so nobody can tell which it was. */
export function notFoundPage() {
  return shell('Link not available', '<main class="missing"><h1>This link is not available</h1><p>It may have expired or been turned off. Ask the person who shared it for a new one.</p></main>');
}

// What the two suggestion buttons ask. They are ordinary questions: they count against the same limits and get the same
// strict answer rules. (Only the buttons that map onto what questions can really do are offered.)
const SUGGESTIONS = [
  { label: 'Write tldr', question: 'Write a tldr of this meeting.' },
  { label: 'List action items', question: 'List the action items from this meeting.' },
];

/**
 * The notes as text: a person's edit (made on the /admin page) if there is one, otherwise the generated summary. summary_text
 * already holds the next steps ("Next steps", or "Action items" before 2026-11-23); the separate action items are only added to
 * a generated summary that lacks both headings (an edited one is shown exactly as edited). The reader page and the editor both
 * start from this, so /admin shows exactly what readers see.
 */
export function notesText(t) {
  if (t.summary_edited) return t.summary_edited;
  let text = t.summary_text ?? '';
  if (t.actions_text && !/\*\*\s*(?:Action items|Next steps)\s*\*\*/i.test(text)) text = `${text ? `${text}\n\n` : ''}**Action items**\n${t.actions_text}`;
  return text;
}

/** The people and date chips under the title (the same on both pages). */
function chipsHtml(t) {
  let speakers = [];
  try {
    const parsed = JSON.parse(t.speakers ?? '[]');
    if (Array.isArray(parsed)) speakers = parsed.map((sp) => String(sp?.name ?? '')).filter(Boolean);
  } catch {
    // no speaker list
  }
  return (
    (speakers.length ? `<span class="chip">${PEOPLE}${speakers.map(esc).join(', ')}</span>` : '') +
    `<span class="chip">${CALENDAR}${esc(dayLabel(t.started_at))}</span>`
  );
}

/**
 * qa: { enabled, maxChars, question?, answer?, error? }. `question` is shown back to the reader (escaped), `answer`
 * comes from the model (escaped, only bold, timestamps and (unverified) are marked up), `error` is one of our own fixed messages.
 */
export function transcriptPage(t, qa = { enabled: false }) {

  const shown = notesText(t);
  const notes = shown ? renderNote(shown) : '<p>No summary is available for this meeting.</p>';
  const chips = chipsHtml(t);

  const note =
    `<main class="note"><div class="article"><h1>Meeting summary</h1><div class="chips">${chips}</div>${notes}` +
    `<p class="fine">Private link. Anyone who has this address can read this page${qa.enabled ? ' and ask questions about the meeting' : ''} until ${esc(utcDay(t.expires_at))}. Please do not share it outside your team.</p></div></main>`;

  if (!qa.enabled) return shell('Meeting summary', `<div class="layout solo">${note}</div>`);

  const max = Number(qa.maxChars) || 500;
  let thread = '';
  if (qa.error) thread += `<p class="err">${esc(qa.error)}</p>`;
  if (qa.answer) {
    thread +=
      `<p class="q">${esc(qa.question)}</p><div class="a">${renderNote(qa.answer)}</div>` +
      "<p class=\"fine\">Answers are written by an AI model from this meeting's transcript and can be wrong. Check anything important with the people who were there.</p>";
  }
  const suggestions = SUGGESTIONS.map(
    (s) => `<form method="post"><button class="suggest" type="submit" name="q" value="${esc(s.question)}"><span class="slash" aria-hidden="true">/</span>${esc(s.label)}</button></form>`,
  ).join('');
  const chat =
    `<aside class="chat" aria-label="Ask about the meeting"><div class="thread">${thread}</div><div class="composer">` +
    `<div class="chips-row">${suggestions}</div>` +
    '<form class="ask" method="post" autocomplete="off"><label class="sr" for="q">Ask about the meeting</label>' +
    `<textarea id="q" name="q" rows="1" maxlength="${max}" required placeholder="Ask about the meeting...">${esc(qa.error ? qa.question ?? '' : '')}</textarea>` +
    `<button class="send" type="submit" aria-label="Ask">${ARROW_UP}</button></form></div></aside><script>${CHAT_SCRIPT}</script>`;
  return shell('Meeting summary', `<div class="layout">${note}${chat}</div>`);
}

// The formatting toolbar (shown above a selection by src/editor-script.js). The commands are the browser's editing commands,
// plus quote, subtext, the two lists and heading, which the script handles.
const TOOLBAR = [
  ['bold', '<strong>B</strong>', 'Bold (Ctrl+B)'],
  ['italic', '<em>I</em>', 'Italic (Ctrl+I)'],
  ['underline', '<u>U</u>', 'Underline (Ctrl+U)'],
  ['strikeThrough', '<s>S</s>', 'Strikethrough (Ctrl+Shift+X)'],
  null,
  ['heading', 'H', 'Heading'],
  ['quote', '\u201C', 'Quote'],
  ['sub', '<small>-#</small>', 'Subtext'],
  null,
  ['ul', '\u2022', 'Bulleted list'],
  ['ol', '1.', 'Numbered list'],
]
  .map((b) => (b ? `<button type="button" data-cmd="${b[0]}" title="${b[2]}" aria-label="${b[2]}" aria-pressed="false">${b[1]}</button>` : '<span class="sep" aria-hidden="true"></span>'))
  .join('');

/**
 * The /admin page: the summary drawn exactly as the reader page draws it, editable in place (src/editor-script.js), saved as you
 * type, with an "Edit with AI" panel when a model is available. The transcript is not shown and cannot be edited here.
 * Without JavaScript the <noscript> text box and the restore button work as plain form posts.
 * opts: { notice?, error?, draft?, aiEnabled? }: `notice` and `error` are our own fixed messages; `draft` is what the person typed
 * in the text box, put back (escaped) when it was refused.
 */
export function adminPage(t, { notice = null, error = null, draft = null, max = 30_000, aiEnabled = false } = {}) {
  const current = draft ?? notesText(t);
  const edited = Boolean(t.summary_edited);
  const version = Number(t.summary_version) || 0;
  const note =
    '<main class="note"><div class="article edit">' +
    '<div class="editbar"><span id="save-status" class="save" role="status" aria-live="polite"></span></div>' +
    `<h1>Meeting summary</h1><div class="chips">${chipsHtml(t)}</div>` +
    (notice ? `<p class="ok" role="status">${esc(notice)}</p>` : '') +
    (error ? `<p class="err" role="alert">${esc(error)}</p>` : '') +
    '<div id="conflict" class="bar" role="alert" hidden><span class="msg">This summary was changed somewhere else after you opened it, so your last change was not saved.</span>' +
    '<button class="btn" type="button" data-act="reload">Load their version</button><button class="btn primary" type="button" data-act="keep">Keep mine</button></div>' +
    '<div id="preview" class="bar" role="status" hidden><span class="msg"></span>' +
    '<button class="btn primary" type="button" data-act="accept">Accept</button><button class="btn" type="button" data-act="discard">Discard</button></div>' +
    `<div id="notes" class="notes" data-version="${version}">${renderNote(current) || '<p><br></p>'}</div>` +
    `<div id="toolbar" class="toolbar" role="toolbar" aria-label="Formatting" hidden>${TOOLBAR}</div>` +
    '<noscript><p class="fine">Editing in place needs JavaScript. You can edit the notes as text instead:</p>' +
    '<form method="post" autocomplete="off"><label class="sr" for="summary">Summary</label>' +
    // the first newline after <textarea> is dropped by HTML parsing, so one is added to keep a leading blank line intact
    `<textarea id="summary" name="summary" rows="24" maxlength="${Number(max)}" required>\n${esc(current)}</textarea>` +
    '<div class="actions"><button class="btn primary" type="submit">Save changes</button></div></form>' +
    '<p class="fine">A line that is only **bold text** is a heading. "- " starts a bullet and "1. " a numbered item (indent by two spaces for a sub-item), "> " a quote and "-# " small print. **bold**, *italic*, __underline__, ~~strikethrough~~. [hh:mm:ss] marks a time.</p></noscript>' +
    (edited ? '<form method="post"><div class="actions"><button class="btn" type="submit" name="restore" value="1">Restore the generated summary</button></div></form>' : '') +
    `<p class="fine">Anyone who has this link can change the summary, so only share it with people you trust. Changes are saved automatically; select text to format it. The transcript itself cannot be edited. ${edited ? 'This summary has been edited; the generated one can be restored with the button above.' : 'This is the generated summary.'} To see the page as readers do, remove /admin from the address.</p>` +
    '</div></main>';
  const ai = aiEnabled
    ? '<aside class="chat" aria-label="Edit with AI" hidden><div class="thread">' +
      '<p class="fine" style="margin-top:0">Tell the AI what to change, for example "Change Toma to Thomas" or "Remove the second section". It proposes the change; nothing is saved until you accept it.</p></div>' +
      '<div class="composer"><form id="ai-form" class="ask" autocomplete="off"><label class="sr" for="ai">What should change?</label>' +
      '<textarea id="ai" name="ai" rows="1" maxlength="500" placeholder="Tell the AI what to change..."></textarea>' +
      `<button class="send" type="submit" aria-label="Send">${ARROW_UP}</button></form></div></aside>`
    : '';
  return shell('Edit the summary', `<div class="layout${ai ? '' : ' solo'}">${note}${ai}</div><script>${EDITOR_SCRIPT}</script>`);
}
