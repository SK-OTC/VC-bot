// Starts the GitHub Actions recorder (.github/workflows/record.yml) with a workflow_dispatch call.
// The token is a fine-grained personal access token with "Actions: Read and write" on this one repository.
// It is never put in an error message, a log line or a reply.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;

/** Returns null when the recorder is not configured, so /start-recording can say so plainly. */
export function createRecorderDispatcher({ token, repo, ref = 'main', workflow = 'record.yml', fetchImpl }) {
  const cleanRef = String(ref || 'main').trim();
  if (!String(token ?? '').trim() || !REPO_RE.test(String(repo ?? '').trim()) || !REF_RE.test(cleanRef)) return null;
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const url = `https://api.github.com/repos/${String(repo).trim()}/actions/workflows/${workflow}/dispatches`;

  return {
    /** inputs: { channel_id, session_id, max_minutes? }. Returns { ok: true } or { ok: false, error }. */
    async dispatch(inputs) {
      const clean = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
      let res;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${String(token).trim()}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'vc-bot-worker',
          },
          body: JSON.stringify({ ref: cleanRef, inputs: clean }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        return { ok: false, error: `could not reach GitHub (${e?.name === 'TimeoutError' ? 'timed out' : 'network error'})` };
      }
      if (res.status === 204 || res.status === 200) return { ok: true };
      if (res.status === 401) return { ok: false, error: 'GitHub rejected the token (GITHUB_DISPATCH_TOKEN is wrong or expired)' };
      if (res.status === 403) return { ok: false, error: 'GitHub refused: the token needs "Actions: Read and write" on the repository (or GitHub rate-limited it)' };
      if (res.status === 404) return { ok: false, error: 'GitHub could not find the repository or workflow, or the token has no access to it (check GITHUB_REPO)' };
      if (res.status === 422) return { ok: false, error: `GitHub rejected the request: the workflow file must exist on branch "${cleanRef}" and allow manual runs` };
      return { ok: false, error: `GitHub answered HTTP ${res.status}` };
    },
  };
}
