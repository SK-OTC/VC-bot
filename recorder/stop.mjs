// When should a recording end? Pure function so every rule can be tested without Discord.

/**
 * state: { now, joinedAt, firstHumanAt|null, humans (count now), emptySince|null, lastSpeechAt|null, stopFlag }
 * cfg:   { maxMinutes, startWaitMinutes, emptyGraceMinutes, silenceStopMinutes }
 * Times are milliseconds. Returns { stop: false } or { stop: true, reason, empty } where `empty` means
 * nobody ever joined (so there is nothing to transcribe).
 */
export function shouldStop(state, cfg) {
  const min = 60_000;
  const { now } = state;
  if (state.stopFlag) return { stop: true, reason: 'stopped with /record stop' };
  if (state.firstHumanAt == null) {
    if (now - state.joinedAt >= cfg.startWaitMinutes * min) return { stop: true, reason: `nobody joined within ${cfg.startWaitMinutes} minutes`, empty: true };
    return { stop: false };
  }
  if (now - state.firstHumanAt >= cfg.maxMinutes * min) return { stop: true, reason: `reached the ${cfg.maxMinutes}-minute limit` };
  if (state.humans === 0 && state.emptySince != null && now - state.emptySince >= cfg.emptyGraceMinutes * min) {
    return { stop: true, reason: 'everyone left the channel' };
  }
  const lastActivity = state.lastSpeechAt ?? state.firstHumanAt;
  if (now - lastActivity >= cfg.silenceStopMinutes * min) return { stop: true, reason: `no one spoke for ${cfg.silenceStopMinutes} minutes` };
  return { stop: false };
}

/** Keeps the empty-channel timer: starts when the last human leaves, resets when someone is back. */
export function trackEmpty(prevEmptySince, humans, now) {
  if (humans > 0) return null;
  return prevEmptySince ?? now;
}

/** Nicknames are limited to 32 characters. */
export function recordingNickname(original, tag = '[REC] ') {
  const base = (original || '').trim();
  if (base.startsWith(tag)) return base.slice(0, 32);
  return (tag + base).slice(0, 32).trimEnd();
}

/** Splits files into Discord messages: at most 10 attachments and about 9.9 MB each; oversized files are listed separately. */
export function batchAttachments(files, { maxCount = 10, maxBytes = 9_900_000, maxTotal = 24_000_000 } = {}) {
  const tooBig = files.filter((f) => f.size > maxBytes);
  const batches = [];
  let cur = [];
  let total = 0;
  for (const f of files.filter((x) => x.size <= maxBytes)) {
    if (cur.length >= maxCount || (cur.length && total + f.size > maxTotal)) {
      batches.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(f);
    total += f.size;
  }
  if (cur.length) batches.push(cur);
  return { batches, tooBig };
}
