// Plain HTTP routes that are not Discord interactions. Returns a Response, or null to let index.js carry on
// with its normal handling (the health check and the signed Discord interactions).
//   /api/...        recorder endpoints (own secret)
//   /t/<token>      a private transcript page (the token in the address is the only key)
//   /robots.txt     tells well-behaved crawlers to stay away from everything
import { handleApi } from './api.js';
import { SECURITY_HEADERS, notFoundPage, transcriptPage } from './share-page.js';
import { TOKEN_RE, findSharedTranscript, recordView } from './share-store.js';

const page = (html, status = 200) => new Response(html, { status, headers: SECURITY_HEADERS });

async function handleShare(request, env, ctx, url, nowSec) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...SECURITY_HEADERS, Allow: 'GET, HEAD' } });
  }
  const token = url.pathname.slice('/t/'.length);
  // Anything that is not exactly a token (wrong length, extra path, odd characters) is the same plain "not available".
  if (!TOKEN_RE.test(token)) return page(notFoundPage(), 404);
  if (!env.DB) {
    console.error('Share pages need the DB binding.');
    return page(notFoundPage(), 404);
  }
  try {
    const t = await findSharedTranscript(env.DB, token, nowSec);
    if (!t) return page(notFoundPage(), 404);
    if (request.method === 'GET') {
      const count = recordView(env.DB, t.token_hash, nowSec);
      if (ctx?.waitUntil) ctx.waitUntil(count);
      else await count;
    }
    return page(transcriptPage(t));
  } catch (e) {
    // Never log the token or any text: only the kind of error.
    console.error(`share page error: ${String(e?.name ?? 'Error').slice(0, 40)}`);
    return page(notFoundPage(), 404);
  }
}

export async function handleHttp(request, env, ctx, nowSec) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, env, url, nowSec);
  if (url.pathname === '/robots.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (url.pathname.startsWith('/t/')) return handleShare(request, env, ctx, url, nowSec);
  return null;
}
