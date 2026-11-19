// Plain HTTP routes that are not Discord interactions. Returns a Response, or null to let index.js carry on
// with its normal handling (the health check and the signed Discord interactions).
import { handleApi } from './api.js';

export async function handleHttp(request, env, ctx, nowSec) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, env, url, nowSec);
  return null;
}
