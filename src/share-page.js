// The read-only web page behind a share link, and the strict headers every response from /t/ carries.
// Security rules for this file:
//  * Every piece of text that came from speech, a Discord name, a language model or a reader is HTML-escaped first.
//  * The page has no scripts, no images and no links. Its only forms post back to the same address (CSP form-action 'self').
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

export const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
 * Escaped text with three marks made visible. Escaping happens FIRST, so the output can only contain the tags written here:
 * **bold** -> <strong>, [hh:mm:ss] -> a muted timestamp, (unverified) -> an italic mark.
 */
function inline(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d{1,2}:\d{2}:\d{2})\]/g, '<span class="ts">[$1]</span>')
    .replace(/\(unverified\)/g, '<span class="unv">(unverified)</span>');
}

/**
 * The model's notes (headings in **bold**, bullets starting "- ") as headings, bullet lists and paragraphs.
 * Bullets indented by 2+ spaces are nested (up to two levels). A final line "Summary written by ..." becomes a quiet byline.
 */
export function renderNote(text) {
  const out = [];
  let list = false;
  const closeList = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^\s*\*\*([^*]+)\*\*:?\s*$/.exec(line); // a line that is ONLY one bold phrase; two bold spans are ordinary text
    if (heading) {
      closeList();
      out.push(`<h2><span class="hash" aria-hidden="true">#</span>${esc(heading[1].trim())}</h2>`);
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) out.push('<ul>');
      list = true;
      const indent = bullet[1].replace(/\t/g, '  ').length;
      const depth = indent >= 6 ? 2 : indent >= 2 ? 1 : 0;
      out.push(`<li class="d${depth}">${inline(bullet[2])}</li>`);
      continue;
    }
    closeList();
    out.push(/^Summary written by /.test(line.trim()) ? `<p class="byline">${esc(line.trim())}</p>` : `<p>${inline(line.trim())}</p>`);
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
:root{color-scheme:dark;--bg:#1b1b17;--panel:#161616;--line:#282824;--chip-line:#23231e;--text:#83837f;--title:#eeeeee;--hash:#32332f;--chip-text:#818481;--input-line:#262626;--placeholder:#818382;--send:#21211e;--suggest:#808386;--err:#ff8787}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.top{height:50px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid var(--line)}
.brand{font-size:1.15rem;font-weight:650;letter-spacing:-.01em;color:var(--title)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 383px;min-height:calc(100vh - 50px)}
.layout.solo{grid-template-columns:minmax(0,1fr)}
.note{padding:4.2rem 24px 5rem}
.article{max-width:600px;margin:0 auto}
h1{font:400 2.15rem/1.18 Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif;color:var(--title);margin:0 0 1rem;letter-spacing:-.01em}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.6rem}
.chip{display:inline-flex;align-items:center;gap:.4rem;border:1px solid var(--chip-line);border-radius:999px;padding:.22rem .7rem;font-size:.8rem;line-height:1.4;color:var(--chip-text)}
h2{position:relative;font-size:.95rem;font-weight:600;color:var(--text);margin:1.5rem 0 .45rem}
.hash{position:absolute;left:-1.15rem;font-weight:400;color:var(--hash)}
ul{margin:.15rem 0 .3rem;padding-left:1.05rem}
li{margin:.3rem 0;color:var(--text)}
li.d1{margin-left:1.1rem;list-style-type:circle}
li.d2{margin-left:2.2rem;list-style-type:square}
p{margin:.5rem 0}
strong{font-weight:600}
.ts{font-variant-numeric:tabular-nums;opacity:.72}
.unv{font-style:italic;opacity:.8}
.byline,.fine{font-size:.8rem;color:var(--chip-text)}
.byline{margin-top:1.6rem}
.fine{margin-top:2.2rem}
.chat{background:var(--panel);border-left:1px solid var(--line);position:sticky;top:50px;height:calc(100vh - 50px);display:flex;flex-direction:column}
.thread{flex:1;overflow-y:auto;padding:1.25rem 1.25rem .5rem}
.q{margin:0 0 .6rem;color:var(--chip-text);font-size:.85rem}
.a p,.a li{color:var(--text)}
.a h2{margin-top:1rem}
.err{color:var(--err);font-size:.9rem}
.composer{padding:.5rem 1.1rem 1.1rem}
.chips-row{display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin:0 0 .8rem .3rem}
.chips-row form{margin:0}
.suggest{display:inline-flex;align-items:center;gap:.4rem;background:none;border:0;padding:.1rem 0;font:inherit;font-size:.78rem;color:var(--suggest);cursor:pointer}
.suggest:hover{color:var(--title)}
.slash{display:inline-grid;place-items:center;width:.95rem;height:.95rem;border:1px solid var(--chip-line);border-radius:3px;font-size:.62rem;line-height:1}
.ask{display:flex;align-items:center;gap:.5rem;border:1px solid var(--input-line);border-radius:999px;background:var(--panel);padding:.35rem .4rem .35rem 1rem}
textarea{flex:1;min-width:0;border:0;outline:0;resize:none;background:transparent;color:var(--title);font:inherit;font-size:.9rem;line-height:1.4;padding:.35rem 0;max-height:7rem;field-sizing:content}
textarea::placeholder{color:var(--placeholder);opacity:1}
.send{flex:none;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--send);color:var(--placeholder);cursor:pointer}
.send:hover{color:var(--title)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:2px solid var(--title);outline-offset:2px}
.ask:focus-within{border-color:var(--chip-text)}
.missing{max-width:30rem;margin:18vh auto 0;padding:0 24px}
.missing h1{font-size:1.8rem}
@media (max-width:900px){
  .layout{display:block}
  .note{padding:2.2rem 18px 2rem}
  .hash{display:none}
  .chat{position:static;height:auto;border-left:0;border-top:1px solid var(--line)}
  .thread{overflow:visible}
}`;

function shell(title, bodyHtml) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">' +
    '<meta name="color-scheme" content="dark">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<header class="top"><span class="brand">VC Bot</span></header>${bodyHtml}</body></html>`
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
 * qa: { enabled, maxChars, question?, answer?, error? }. `question` is shown back to the reader (escaped), `answer`
 * comes from the model (escaped, only bold, timestamps and (unverified) are marked up), `error` is one of our own fixed messages.
 */
export function transcriptPage(t, qa = { enabled: false }) {
  let speakers = [];
  try {
    const parsed = JSON.parse(t.speakers ?? '[]');
    if (Array.isArray(parsed)) speakers = parsed.map((s) => String(s?.name ?? '')).filter(Boolean);
  } catch {
    // no speaker list
  }

  // The notes. summary_text already holds all four sections; the separate action items are only added if it lacks them.
  let notes = t.summary_text ? renderNote(t.summary_text) : '';
  if (t.actions_text && !/\*\*\s*Action items\s*\*\*/i.test(t.summary_text ?? '')) {
    notes += renderNote(`**Action items**\n${t.actions_text}`);
  }
  if (!notes) notes = '<p>No summary is available for this meeting.</p>';

  const chips =
    (speakers.length ? `<span class="chip">${PEOPLE}${speakers.map(esc).join(', ')}</span>` : '') +
    `<span class="chip">${CALENDAR}${esc(dayLabel(t.started_at))}</span>`;

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
    `<button class="send" type="submit" aria-label="Ask">${ARROW_UP}</button></form></div></aside>`;
  return shell('Meeting summary', `<div class="layout">${note}${chat}</div>`);
}
