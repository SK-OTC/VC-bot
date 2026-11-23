// Asks the Worker where this recording's transcript goes (the settings an admin made with /recording voice-channel).
// The mapping of channels is fetched here instead of being passed as workflow inputs, because the inputs of a run in a
// public repository are public. Nothing fetched is ever logged. Never throws.
import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Returns { found: true, team } or { found: false, reason, ended? }. `reason` is a short fixed phrase, safe to log. `ended` means the
 * session is already over and the job must not record.
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
      // The session already ended (this job was re-run, or is a second copy): the caller must stop, not fall back to TEAM_CONFIG,
      // or the meeting would be recorded and posted twice.
      if (res.status === 409) return { found: false, ended: true, reason: 'this recording session has already ended' };
      if (res.status === 401 || res.status === 403) return { found: false, reason: 'the Worker rejected WORKER_SHARED_SECRET' };
      if (res.ok) {
        const c = await res.json();
        return {
          found: true,
          team: {
            voiceChannelId: String(c.voice_channel_id ?? ''),
            name: String(c.name ?? ''),
            transcriptChannelId: String(c.transcript_channel_id ?? ''), // '' when posting is off
            save: c.save !== false,
            post: c.post !== false,
            dmUserId: c.dm_user_id ? String(c.dm_user_id) : '', // who gets the summary link privately when posting is off
            backupChannelId: c.backup_channel_id ? String(c.backup_channel_id) : '',
            glossary: String(c.glossary ?? ''),
            language: String(c.language ?? ''),
            // From the named recording setup (/recording setup); '' = not used.
            summaryChannelId: c.summary_channel_id ? String(c.summary_channel_id) : '',
            linkChannelId: c.link_channel_id ? String(c.link_channel_id) : '',
            audioChannelId: c.audio_channel_id ? String(c.audio_channel_id) : '',
            setupName: c.setup_name ? String(c.setup_name) : '',
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
