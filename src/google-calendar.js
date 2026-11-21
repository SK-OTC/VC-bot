// Creates, changes and cancels Google Calendar events through the Calendar API, as the project manager who connected their
// Google account (see calendar-access.js). It answers exactly like the Apps Script bridge client (src/bridge.js), so the sync queue
// (src/calendar-sync.js) treats both the same way:
//   { ok: true, eventId, meetLink, htmlLink, created }
//   { ok: false, retryable, error }   (plus `code` when the cause is the sign-in itself, e.g. 'invalid_grant')
//
// Rules that hold throughout:
//  - Events go on the PM's primary calendar, with sendUpdates=all so guests get the invite, the update and the cancellation.
//  - extendedProperties.private.meetingId carries OUR meeting id, so an event can always be traced back to its meeting.
//  - Meet: on unless the meeting asked for none. Every insert and every patch sends conferenceDataVersion=1 (without it a patch can
//    drop the link), and each creation attempt uses a new requestId. A retry of a create that already succeeded is safe because
//    the event id is chosen by us and saved first: Google answers 409, and we read the existing event back instead.
//  - Never logs. No token ever appears in a returned message; Google's own error text is cut short and only ever shown privately.
import { getAccessToken } from './calendar-access.js';

const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_GUESTS = 100; // the same cap as a guest team
const MEET_POLLS = 3;
const MEET_POLL_MS = 700;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError']);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class InvalidEvent extends Error {}

/** The Google event body for a payload built by calendar-sync's buildPayload. Throws InvalidEvent with a plain reason. */
export function buildEventResource(p, { isCreate }) {
  const title = String(p.title ?? '').trim();
  if (!title || title.length > 200) throw new InvalidEvent('title must be 1-200 characters');
  const startSec = Number(p.startSec);
  const durationMin = Number(p.durationMin);
  if (!Number.isFinite(startSec) || startSec <= 0) throw new InvalidEvent('the start time is not valid');
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 1440) throw new InvalidEvent('the length must be 5 to 1440 minutes');
  const timeZone = String(p.timezone ?? '');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new InvalidEvent(`unknown time zone: ${timeZone.slice(0, 40)}`);
  }
  const guests = Array.isArray(p.guests) ? p.guests : [];
  if (guests.length > MAX_GUESTS) throw new InvalidEvent(`too many guests (max ${MAX_GUESTS})`);
  const seen = new Set();
  const attendees = [];
  for (const g of guests) {
    const email = String(g ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new InvalidEvent(`not a valid email address: ${email.slice(0, 60)}`);
    if (!seen.has(email)) {
      seen.add(email);
      attendees.push({ email });
    }
  }

  const resource = {
    summary: title,
    description: String(p.description ?? '').slice(0, 4000),
    location: p.location ? String(p.location).slice(0, 200) : '',
    start: { dateTime: new Date(startSec * 1000).toISOString(), timeZone },
    end: { dateTime: new Date((startSec + durationMin * 60) * 1000).toISOString(), timeZone },
    attendees,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    extendedProperties: { private: { meetingId: String(p.meetingId ?? '') } },
  };
  if (p.repeat === 'weekly') resource.recurrence = ['RRULE:FREQ=WEEKLY'];
  if (isCreate) {
    resource.id = p.eventId;
    if (p.meet !== false) {
      resource.conferenceData = {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      };
    }
  }
  return resource;
}

const emailSet = (list) => new Set((list ?? []).map((a) => String(a.email ?? '').toLowerCase()).filter(Boolean));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function eventResult(ev, created) {
  let meetLink = ev.hangoutLink || '';
  if (!meetLink) {
    for (const entry of ev.conferenceData?.entryPoints ?? []) {
      if (!meetLink && entry.entryPointType === 'video') meetLink = entry.uri;
    }
  }
  return { ok: true, eventId: ev.id, meetLink, htmlLink: ev.htmlLink || '', created };
}

/** Turns a failed Google answer into { ok: false, retryable, error }. */
function failure(r) {
  if (r.network) return { ok: false, retryable: true, error: `Google Calendar: ${r.error}.` };
  const status = r.status;
  const reason = String(r.json?.error?.errors?.[0]?.reason ?? r.json?.error?.status ?? '');
  const detail = String(r.json?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
  const transient = status >= 500 || status === 429 || RATE_LIMIT_REASONS.has(reason);
  if (transient) return { ok: false, retryable: true, error: `Google Calendar: Google answered HTTP ${status}. This is usually temporary.` };
  if (status === 401) return { ok: false, retryable: true, error: 'Google Calendar: Google did not accept the access token (HTTP 401). It will be retried.' };
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + detail)) {
    return { ok: false, retryable: false, error: 'Google Calendar: the Google Calendar API is not turned on for the bot\'s Google Cloud project. Tell the server admin.' };
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason + detail)) {
    return { ok: false, retryable: false, error: 'Google Calendar: the bot was not given calendar permission. Reconnect with `/calendar connect` and leave every box ticked.' };
  }
  if (status === 404 || status === 410) return { ok: false, retryable: false, error: 'Google Calendar: the event was not found (it may have been deleted in Google Calendar).' };
  return { ok: false, retryable: false, error: `Google Calendar: Google refused the request (HTTP ${status}${detail ? `: ${detail}` : ''}).` };
}

/**
 * @param db         D1 (the sign-in lookup)
 * @param config     googleConfig(env)
 * @param fetchImpl  tests only
 * @param sleep      tests only
 */
export function createGoogleCalendarClient({ db, config, fetchImpl, sleep = defaultSleep, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  async function request(method, url, accessToken, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const timedOut = e?.name === 'AbortError' || controller.signal.aborted;
      return { network: true, error: timedOut ? `Google did not answer within ${Math.round(timeoutMs / 1000)} seconds` : 'could not reach Google' };
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        // no body
      }
    }
    return { ok: res.ok, status: res.status, json };
  }

  const eventUrl = (id, params) => {
    const query = new URLSearchParams(params).toString();
    return `${EVENTS}/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
  };
  const sendUpdates = (p) => (p.sendInvites === false ? 'none' : 'all');

  async function waitForMeet(token, ev, wantMeet) {
    let polls = 0;
    while (wantMeet && polls < MEET_POLLS && !ev.hangoutLink && ev.conferenceData?.createRequest?.status?.statusCode === 'pending') {
      await sleep(MEET_POLL_MS);
      const again = await request('GET', eventUrl(ev.id, {}), token);
      if (!again.ok) break; // keep what we have; the caller says the link is missing
      ev = again.json;
      polls++;
    }
    return ev;
  }

  async function create(token, p) {
    const r = await request('POST', `${EVENTS}?${new URLSearchParams({ conferenceDataVersion: '1', sendUpdates: sendUpdates(p) })}`, token, buildEventResource(p, { isCreate: true }));
    let ev;
    let created = true;
    if (r.status === 409) {
      // Our id already exists: a retry of a create that went through. Read it back instead of making a second event.
      const existing = await request('GET', eventUrl(p.eventId, {}), token);
      if (!existing.ok) return failure(existing);
      if (existing.json?.status === 'cancelled') return { ok: false, retryable: false, error: 'Google Calendar: this event id belongs to an event that was deleted.' };
      ev = existing.json;
      created = false;
    } else if (!r.ok) {
      return failure(r);
    } else {
      ev = r.json;
    }
    return eventResult(await waitForMeet(token, ev, p.meet !== false), created);
  }

  async function update(token, p) {
    const existing = await request('GET', eventUrl(p.eventId, {}), token);
    if (!existing.ok) return failure(existing);
    if (existing.json?.status === 'cancelled') return { ok: false, retryable: false, error: 'Google Calendar: the event was deleted in Google Calendar.' };

    const patch = buildEventResource(p, { isCreate: false });
    // Only send the guest list when it really changed, so guests' replies are kept.
    const have = emailSet((existing.json?.attendees ?? []).filter((a) => !a.self && !a.organizer));
    if (sameSet(have, emailSet(patch.attendees))) delete patch.attendees;

    const r = await request('PATCH', eventUrl(p.eventId, { conferenceDataVersion: '1', sendUpdates: sendUpdates(p) }), token, patch);
    if (!r.ok) return failure(r);
    return eventResult(r.json, false);
  }

  async function cancel(token, p) {
    const r = await request('DELETE', eventUrl(p.eventId, { sendUpdates: sendUpdates(p) }), token);
    if (r.ok || r.status === 404 || r.status === 410) return { ok: true, eventId: p.eventId, cancelled: true }; // already gone is fine
    return failure(r);
  }

  /**
   * @param who      { ownerId, teamId, nowSec }: whose Google account, for which server (a connection is used only for its own server)
   * @param payload  what calendar-sync's buildPayload makes (action: 'create' | 'update' | 'cancel')
   */
  async function call({ ownerId, teamId, nowSec }, payload) {
    const tok = await getAccessToken({ db, config, discordUserId: ownerId, teamId, nowSec, fetchImpl, sleep });
    if (!tok.ok) return { ok: false, retryable: tok.retryable, error: tok.error, code: tok.kind };
    try {
      if (payload.action === 'create') return await create(tok.accessToken, payload);
      if (payload.action === 'update') return await update(tok.accessToken, payload);
      if (payload.action === 'cancel') return await cancel(tok.accessToken, payload);
      return { ok: false, retryable: false, error: 'Google Calendar: unknown action' };
    } catch (e) {
      if (e instanceof InvalidEvent) return { ok: false, retryable: false, error: `Google Calendar: ${e.message}` };
      throw e;
    }
  }

  // signIn: the public sign-in settings (no secret), for building a reconnect link when a sign-in stops working.
  return { call, signIn: { clientId: config.clientId, redirectUri: config.redirectUri } };
}
