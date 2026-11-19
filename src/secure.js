// Small security helpers. Nothing here logs anything.

const enc = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

/**
 * Compares two secrets without leaking how many leading characters match. Both sides are hashed first, so
 * the comparison always walks the same 32 bytes and the length of the secret does not leak either.
 */
export async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <secret>` with exactly the expected secret. */
export async function bearerMatches(request, expected) {
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  // Always run the comparison, even with no header, so a missing header costs the same as a wrong one.
  return constantTimeEqual(m ? m[1] : '', expected).then((ok) => ok && Boolean(m));
}
