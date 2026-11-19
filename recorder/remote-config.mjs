// Asks the Worker where this recording's transcript goes (the settings an admin made with /setup-recording).
// The mapping of channels is fetched here instead of being passed as workflow inputs, because the inputs of a run in a
// public repository are public. Nothing fetched is ever logged. Never throws.
import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Returns { found: true, team } or { found: false, reason }. `reason` is a short fixed phrase, safe to log.
 * Without SESSION_ID, WORKER_URL and WORKER_SHARED_SECRET (a run started by hand) it simply finds nothing, and the
 * caller falls back to the TEAM_CONFIG secret.
 */
export async function fetchRemoteTeam(env, { fetchImpl = fetch, sleep = sleepFor, attempts = 3 } = {}) {
  const sessionId = String(env.SESSION_ID ?? '').trim();
  const workerUrl = String(env.WORKER_URL ?? '').trim().replace(/\/+$/, '');
  const secret = String(env.WORKER_SHARED_SECRET ?? '').trim();
  if (!sessionId || !workerUrl.startsWith('https://') || !secret || !/^[A-Za-z0-9_-]{4,40}$/.test(sessionId)) {
    return { found: false, reason: 'not started by the Worker' };
  }
  let reason = 'the Worker could not be reached';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(`${workerUrl}/api/sessions/${encodeURIComponent(sessionId)}/config`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return { found: false, reason: 'the Worker has no setup for this voice channel' };
      if (res.status === 401 || res.status === 403) return { found: false, reason: 'the Worker rejected WORKER_SHARED_SECRET' };
      if (res.ok) {
        const c = await res.json();
        return {
          found: true,
          team: {
            voiceChannelId: String(c.voice_channel_id ?? ''),
            name: String(c.name ?? ''),
            transcriptChannelId: String(c.transcript_channel_id ?? ''),
            backupChannelId: c.backup_channel_id ? String(c.backup_channel_id) : '',
            glossary: String(c.glossary ?? ''),
            language: String(c.language ?? ''),
          },
        };
      }
      reason = `the Worker answered HTTP ${res.status}`;
    } catch {
      reason = 'the Worker could not be reached';
    }
    if (i < attempts) await sleep(1500 * i);
  }
  return { found: false, reason };
}
