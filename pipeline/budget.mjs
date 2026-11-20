// Asks the Worker whether today's Cloudflare Neuron budget still has room for a summary (GET /api/ai-budget).
// The runner cannot see the account-wide meter, only the Worker can, so the runner asks before choosing a model.
// If the Worker cannot be reached the answer is "unknown" and the caller tries Cloudflare anyway: if the allowance is
// really gone Cloudflare refuses and the fallback model takes over, so a failed check never blocks a summary.

/** Returns { known: true, allowed, neurons, cap } or { known: false }. Never throws. */
export async function fetchSummaryBudget({ workerUrl, secret, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!workerUrl || !secret) return { known: false };
  try {
    const res = await fetchImpl(`${String(workerUrl).replace(/\/+$/, '')}/api/ai-budget`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { known: false };
    const j = await res.json();
    if (typeof j?.summary_allowed !== 'boolean') return { known: false };
    return { known: true, allowed: j.summary_allowed, neurons: Number(j.neurons_today) || 0, cap: Number(j.summary_cap) || 0 };
  } catch {
    return { known: false };
  }
}
