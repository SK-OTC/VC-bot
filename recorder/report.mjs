// Tells the Worker the job has ended, so the voice channel can be recorded again. Best effort: a failure here
// only means the Worker clears the session later on its own (see failStaleSessions). Never throws, sends no
// transcript text, and works even when the full settings could not be read.

/** env: process.env. status: 'done' | 'failed'. Returns true when the Worker accepted it. */
export async function reportFinish(env, status, error = '', { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const sessionId = String(env.SESSION_ID ?? '').trim();
  const workerUrl = String(env.WORKER_URL ?? '').trim().replace(/\/+$/, '');
  const secret = String(env.WORKER_SHARED_SECRET ?? '').trim();
  if (!sessionId || !workerUrl.startsWith('https://') || !secret || !/^[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return false;
  try {
    const res = await fetchImpl(`${workerUrl}/api/sessions/${encodeURIComponent(sessionId)}/finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, error: String(error ?? '').slice(0, 200) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
