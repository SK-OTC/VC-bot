// The read-only web page behind a share link, and the strict headers every response from /t/ carries.
// Security rules for this file:
//  * Every piece of text that came from speech, a Discord name or a language model is HTML-escaped first.
//  * The page has no scripts, no images, no forms and no links, so there is nothing to inject into or click through.
//  * Pages are never cached, never indexed, and never send a Referer header on.

export const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

/** Escaped text with Discord-style **bold** shown as bold. Escaping happens first, so the output can only contain <strong>. */
function lite(text) {
  return esc(text).replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
}

const hhmmss = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const utc = (sec) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const utcDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#6b6560;--card:#fff;--line:#e7e5e4;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#ece9e6;--muted:#a09a94;--card:#1f1d1c;--line:#34312f;--accent:#8ea2f5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 16px 4rem}
h1{font-size:1.45rem;margin:.2rem 0 .3rem}
h2{font-size:1.05rem;margin:0 0 .6rem;color:var(--accent)}
.meta{color:var(--muted);font-size:.92rem;margin:0 0 1.2rem}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin:0 0 1rem}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.transcript{font:.9rem/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.note{color:var(--muted);font-size:.85rem;margin-top:1.5rem}
`;

function shell(title, bodyHtml) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">' +
    `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${bodyHtml}</main></body></html>`
  );
}

/** The same page for a wrong, expired, revoked or malformed link, so nobody can tell which it was. */
export function notFoundPage() {
  return shell('Link not available', '<h1>This link is not available</h1><p class="meta">It may have expired or been turned off. Ask the person who shared it for a new one.</p>');
}

export function transcriptPage(t) {
  let speakers = [];
  try {
    const parsed = JSON.parse(t.speakers ?? '[]');
    if (Array.isArray(parsed)) speakers = parsed.map((s) => String(s?.name ?? '')).filter(Boolean);
  } catch {
    // no speaker list
  }
  // The date and length are built from numbers only, so they are safe as they are; names are escaped.
  const meta = [utc(t.started_at), hhmmss(t.duration_sec)];
  if (speakers.length) meta.push(speakers.map(esc).join(', '));

  const parts = [`<h1>Meeting transcript</h1><p class="meta">${meta.join(' · ')}</p>`];
  if (t.summary_text) parts.push(`<section><h2>Summary</h2><p class="text">${lite(t.summary_text)}</p></section>`);
  if (t.actions_text) parts.push(`<section><h2>Action items</h2><p class="text">${lite(t.actions_text)}</p></section>`);
  parts.push(`<section><h2>Transcript</h2><p class="text transcript">${esc(t.transcript_text)}</p></section>`);
  parts.push(`<p class="note">Private link. Anyone who has this address can read this page until ${esc(utcDay(t.expires_at))}. Please do not share it outside your team.</p>`);
  return shell('Meeting transcript', parts.join(''));
}
