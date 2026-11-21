// A fake Google: the token endpoint plus a small in-memory Calendar API (insert, get, patch, delete), so the real client code runs.
// Every request is recorded in `calls` ({ method, url (a URL), headers, body }). `force` queues replies that are used instead of the
// normal behaviour, one per CALENDAR call (never for the token endpoint).
export const ACCESS = 'fake-access-token-xyz789';
export const MEET = 'https://meet.google.com/abc-defg-hij';

export function createFakeGoogle({ tokenReply: initialTokenReply, pendingMeet = false } = {}) {
  let tokenReply = initialTokenReply;
  const calls = [];
  const events = new Map();
  const forced = [];
  let tokenCalls = 0;
  const revokes = []; // the tokens sent to the revoke endpoint
  let revokeReply = { status: 200, body: {} };

  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      revokes.push(new URLSearchParams(init.body).get('token'));
      if (revokeReply instanceof Error) throw revokeReply;
      return json(revokeReply.status, revokeReply.body);
    }
    if (url.host === 'oauth2.googleapis.com') {
      tokenCalls++;
      return tokenReply ? json(tokenReply.status ?? 200, tokenReply.body) : json(200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' });
    }
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: init.headers ?? {}, body });
    if (forced.length) {
      const next = forced.shift();
      if (next instanceof Error) throw next;
      return json(next.status ?? 200, next.body);
    }
    const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '');
    if (method === 'POST') {
      if (events.has(body.id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
      const ev = { ...body, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${body.id}` };
      if (body.conferenceData) {
        if (pendingMeet) ev.conferenceData = { createRequest: { status: { statusCode: 'pending' } } };
        else {
          ev.hangoutLink = MEET;
          ev.conferenceData = { entryPoints: [{ entryPointType: 'video', uri: MEET }] };
        }
      }
      events.set(body.id, ev);
      return json(200, ev);
    }
    const ev = events.get(id);
    if (!ev) return json(404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    if (method === 'GET') {
      if (pendingMeet && ev.conferenceData?.createRequest) {
        ev.hangoutLink = MEET;
        ev.conferenceData = { entryPoints: [{ entryPointType: 'video', uri: MEET }] };
      }
      return json(200, ev);
    }
    if (method === 'PATCH') {
      Object.assign(ev, body);
      return json(200, ev);
    }
    if (method === 'DELETE') {
      if (ev.status === 'cancelled') return json(410, { error: { code: 410, message: 'Resource has been deleted', errors: [{ reason: 'deleted' }] } });
      ev.status = 'cancelled';
      return json(204);
    }
    return json(405, {});
  }

  return {
    fetchImpl,
    calls,
    events,
    force: (...replies) => forced.push(...replies),
    revokes,
    /** What the revoke endpoint answers from now on: { status, body } or an Error (= unreachable). Default: 200. */
    setRevokeReply: (reply) => {
      revokeReply = reply;
    },
    /** Changes what the token endpoint answers from now on, e.g. { status: 400, body: { error: 'invalid_grant' } } = access revoked. null = normal. */
    setTokenReply: (reply) => {
      tokenReply = reply ?? undefined;
    },
    get tokenCalls() {
      return tokenCalls;
    },
  };
}
