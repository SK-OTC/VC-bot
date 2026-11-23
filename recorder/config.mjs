// Settings for one recording session. Everything team-specific comes from /setup-recording (fetched from the Worker) or,
// as a fallback, the TEAM_CONFIG secret, so the public workflow only ever sees a channel ID and a session ID.
// Nothing here talks to Discord.

const ID_RE = /^\d{17,20}$/;

function intIn(value, fallback, min, max, name, problems) {
  const s = String(value ?? '').trim();
  if (s === '') return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

/**
 * TEAM_CONFIG is JSON: { "<voice channel id>": { "name": "Team A", "transcriptChannelId": "...",
 *   "backupChannelId": "..." (optional), "glossary": "LiteCut, CapCut" (optional), "language": "en" (optional) } }
 * Only the entry for the channel being recorded is used, so teams are never mixed.
 */
export function parseSessionConfig(env, remote = null) {
  const problems = [];
  const token = String(env.DISCORD_TOKEN ?? '').trim();
  if (!token) problems.push('DISCORD_TOKEN is missing');

  const channelId = String(env.CHANNEL_ID ?? '').trim();
  if (!ID_RE.test(channelId)) problems.push('CHANNEL_ID must be a voice channel ID (17-20 digits)');

  // Settings made with /setup-recording come from the Worker (`remote`) and win. TEAM_CONFIG is the fallback for
  // runs started by hand or from before /setup-recording existed.
  let team = null;
  if (remote) {
    if (ID_RE.test(channelId) && remote.voiceChannelId !== channelId) problems.push('the settings from the Worker are for a different voice channel');
    team = remote;
  } else {
    try {
      const all = JSON.parse(String(env.TEAM_CONFIG ?? '').trim() || '{}');
      team = all[channelId] ?? null;
    } catch {
      problems.push('TEAM_CONFIG is not valid JSON');
    }
  }
  if (!team && ID_RE.test(channelId)) {
    problems.push('There are no recording settings for this voice channel (no /setup-recording from the Worker, and TEAM_CONFIG has no entry for it), so the bot does not know where to post');
  }
  // save / post come from /transcript-settings (default: both on). A hand-run with TEAM_CONFIG always saves and posts.
  const save = team ? team.save !== false : true;
  const post = team ? team.post !== false : true;
  if (team) {
    if (!save && !post) problems.push('saving and posting are both off, so the transcript would be thrown away (change it with /transcript-settings)');
    if (post && !ID_RE.test(String(team.transcriptChannelId ?? ''))) problems.push('there is no channel to post the transcript in (TEAM_CONFIG entry needs transcriptChannelId, or start the recording with /start-recording)');
    if (team.backupChannelId && !ID_RE.test(String(team.backupChannelId))) problems.push('backupChannelId must be a channel ID');
    if (team.backupChannelId && team.backupChannelId === team.transcriptChannelId) problems.push('backupChannelId must be a different channel from transcriptChannelId');
    for (const f of ['summaryChannelId', 'linkChannelId', 'audioChannelId']) {
      if (team[f] && !ID_RE.test(String(team[f]))) problems.push(`${f} must be a channel ID`);
    }
  }

  const sessionId = String(env.SESSION_ID ?? '').trim();
  if (sessionId && !/^[A-Za-z0-9_-]{4,40}$/.test(sessionId)) problems.push('SESSION_ID may only contain letters, digits, - and _');

  const maxMinutes = intIn(env.MAX_MINUTES, 150, 5, 240, 'MAX_MINUTES', problems);
  const startWaitMinutes = intIn(env.START_WAIT_MINUTES, 15, 1, 60, 'START_WAIT_MINUTES', problems);
  const emptyGraceMinutes = intIn(env.EMPTY_GRACE_MINUTES, 3, 1, 30, 'EMPTY_GRACE_MINUTES', problems);
  const silenceStopMinutes = intIn(env.SILENCE_STOP_MINUTES, 20, 2, 120, 'SILENCE_STOP_MINUTES', problems);
  const readyTimeoutSec = intIn(env.READY_TIMEOUT_SEC, 30, 5, 120, 'READY_TIMEOUT_SEC', problems);
  // How long transcription may take before the rest is handed to the fallback engine (the job limit is 345 minutes).
  const parakeetBudgetMin = intIn(env.PARAKEET_BUDGET_MIN, 120, 5, 300, 'PARAKEET_BUDGET_MIN', problems);

  const workerUrl = String(env.WORKER_URL ?? '').trim().replace(/\/+$/, '');
  if (workerUrl && !/^https:\/\//.test(workerUrl)) problems.push('WORKER_URL must start with https://');

  if (problems.length) throw new Error(problems.join('; '));
  return {
    token,
    channelId,
    sessionId,
    team: {
      name: String(team.name || 'Team'),
      transcriptChannelId: post ? String(team.transcriptChannelId) : '',
      save,
      post,
      dmUserId: /^\d{17,20}$/.test(String(team.dmUserId ?? '')) ? String(team.dmUserId) : '',
      backupChannelId: team.backupChannelId ? String(team.backupChannelId) : '',
      glossary: String(team.glossary || ''),
      language: String(team.language || 'en'),
      // Named recording setup (/recording setup). Each '' when unused; none of them applies while posting is off.
      summaryChannelId: post && team.summaryChannelId ? String(team.summaryChannelId) : '',
      linkChannelId: post && team.linkChannelId ? String(team.linkChannelId) : '',
      audioChannelId: team.audioChannelId ? String(team.audioChannelId) : '',
      setupName: String(team.setupName || ''),
    },
    maxMinutes,
    startWaitMinutes,
    emptyGraceMinutes,
    silenceStopMinutes,
    readyTimeoutSec,
    parakeetBudgetMin,
    workerUrl,
    workerSecret: String(env.WORKER_SHARED_SECRET ?? '').trim(),
    groqKey: String(env.GROQ_API_KEY ?? '').trim(),
  };
}
